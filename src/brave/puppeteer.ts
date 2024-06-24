import * as pathLib from 'path'

import fsExtraLib from 'fs-extra'
import tmpLib from 'tmp'
import puppeteerLib from 'puppeteer-core'

import { getLogger } from './debug.js'

export const TimeoutError = puppeteerLib.errors.TimeoutError

const disabledBraveFeatures = [
  'BraveSync',
  'Speedreader',
  'Playlist',
  'BraveVPN',
  'AIRewriter',
  'AIChat',
  'BravePlayer',
  'BraveDebounce',
  'BraveRewards',
  'BraveSearchOmniboxBanner',
  'BraveGoogleSignInPermission',
  'BraveNTPBrandedWallpaper',
  'AdEvent',
  'NewTabPageAds',
  'CustomNotificationAds',
  'InlineContentAds',
  'PromotedContentAds',
  'TextClassification',
  'SiteVisit'
]

const profilePathForArgs = (args: CrawlArgs): { path: FilePath, shouldClean: boolean } => {
  const logger = getLogger(args)

  // The easiest case is if we've been told to use an existing profile.
  // In this case, just return the given path.
  if (args.existingProfilePath !== undefined) {
    logger.debug(`Crawling with profile at ${args.existingProfilePath}.`)
    return { path: args.existingProfilePath, shouldClean: false }
  }

  // Next, figure out which existing profile we're going to use as the
  // template / starter profile for the new crawl.
  const resourcesDirPath = pathLib.join(process.cwd(), 'resources')
  const templateProfile = args.withShieldsUp
    ? pathLib.join(resourcesDirPath, 'shields-up-profile')
    : pathLib.join(resourcesDirPath, 'shields-down-profile')

  // Finally, either copy the above profile to the destination path
  // that was specified, or figure out a temporary location for it.
  const destProfilePath = args.persistProfilePath !== undefined
    ? args.persistProfilePath
    : tmpLib.dirSync({ prefix: 'pagegraph-profile-' }).name

  const shouldClean = args.persistProfilePath === undefined

  fsExtraLib.copySync(templateProfile, destProfilePath)
  logger.debug(`Crawling with profile at ${String(destProfilePath)}.`)
  return { path: destProfilePath, shouldClean }
}

export const puppeteerConfigForArgs = (args: CrawlArgs): any => {
  const { path: pathForProfile, shouldClean } = profilePathForArgs(args)

  process.env.PAGEGRAPH_OUT_DIR = args.outputPath

  const puppeteerArgs = {
    defaultViewport: null,
    args: [
      '--disable-brave-update',
      '--user-data-dir=' + pathForProfile,
      '--disable-site-isolation-trials',
      '--disable-component-update',
      '--deny-permission-prompts',
      '--enable-features=PageGraph',
      '--disable-features=' + disabledBraveFeatures.join(',')
    ],
    executablePath: args.executablePath,
    ignoreDefaultArgs: [
      '--disable-sync'
    ],
    dumpio: args.debugLevel === 'verbose',
    headless: false
  }

  if (args.debugLevel === 'verbose') {
    puppeteerArgs.args.push('--enable-logging=stderr')
    puppeteerArgs.args.push('--vmodule=page_graph*=2')
  }

  if (args.extensionsPath !== undefined) {
    puppeteerArgs.args.push('--disable-extensions-except=' + args.extensionsPath)
    puppeteerArgs.args.push('--load-extension=' + args.extensionsPath)
  }

  if (args.proxyServer != null) {
    puppeteerArgs.args.push(`--proxy-server=${args.proxyServer.toString()}`)
    if (args.proxyServer.protocol === 'socks5') {
      puppeteerArgs.args.push(`--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE ${args.proxyServer.hostname}`)
    }
  }

  if (args.extraArgs != null) {
    puppeteerArgs.args.push(...args.extraArgs)
  }

  return { puppeteerArgs, pathForProfile, shouldClean }
}

const asyncSleep = async (millis: number): Promise<void> => {
  return await new Promise(resolve => setTimeout(resolve, millis))
}

const defaultComputeTimeout = (tryIndex: number): number => {
  return Math.pow(2, tryIndex - 1) * 1000
}

export const launchWithRetry = async (puppeteerArgs: any, logger: Logger, retryOptions?: LaunchRetryOptions): Promise<any> /* puppeteer Browser */ => {
  // default to 3 retries with a base-2 exponential-backoff delay between each retry (1s, 2s, 4s, ...)
  const retries: number = retryOptions === undefined ? 3 : +retryOptions.retries
  const computeTimeout = retryOptions !== undefined
    ? retryOptions.computeTimeout
    : defaultComputeTimeout

  try {
    return puppeteerLib.launch(puppeteerArgs)
  } catch (err) {
    logger.debug(`Failed to launch browser (${String(err)}): ${retries} left...`)
  }

  for (let i = 1; i <= retries; ++i) {
    await asyncSleep(computeTimeout(i))
    try {
      return puppeteerLib.launch(puppeteerArgs)
    } catch (err) {
      logger.debug(`Failed to launch browser (${String(err)}): ${retries - i} left...`)
    }
  }

  throw new Error(`Unable to launch browser after ${retries} retries!`)
}
