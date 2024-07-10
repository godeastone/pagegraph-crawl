import * as pathLib from 'path'

import fsExtraLib from 'fs-extra'
import tmpLib from 'tmp'
import puppeteerLib from 'puppeteer-core'
import type { LaunchOptions, Process } from 'puppeteer-core'

import { getLogger } from './debug.js'

type LaunchOptionsType = typeof LaunchOptions
type ProcessType = typeof Process

const disabledBraveFeatures = [
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
  'SiteVisit',
]

interface ProfilePath {
  profilePath: FilePath
  shouldClean: boolean
}

const profilePathForArgs = (args: CrawlArgs): ProfilePath => {
  const logger = getLogger(args)

  // The easiest case is if we've been told to use an existing profile.
  // In this case, just return the given path.
  if (args.existingProfilePath !== undefined) {
    logger.verbose(`Crawling with profile at ${args.existingProfilePath}.`)
    return { profilePath: args.existingProfilePath, shouldClean: false }
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
  logger.verbose(`Crawling with profile at ${String(destProfilePath)}.`)
  return { profilePath: destProfilePath, shouldClean }
}

export const puppeteerConfigForArgs = (args: CrawlArgs): PuppeteerConfig => {
  const { profilePath, shouldClean } = profilePathForArgs(args)

  process.env.PAGEGRAPH_OUT_DIR = args.outputPath

  const chromeArgs = [
    '--disable-brave-update',
    '--user-data-dir=' + profilePath,
    '--disable-site-isolation-trials',
    '--disable-component-update',
    '--deny-permission-prompts',
    '--enable-features=PageGraph',
    '--disable-sync',
    '--no-first-run',
    '--disable-renderer-backgrounding',
    '--disable-breakpad',
    '--disable-component-extensions-with-background-pages',
    '--disable-ipc-flooding-protection',
    '--disable-notifications',
    '--mute-audio',
    '--disable-features=' + disabledBraveFeatures.join(','),
  ]

  const puppeteerArgs = {
    defaultViewport: null,
    args: chromeArgs,
    executablePath: args.executablePath,
    dumpio: args.debugLevel === 'verbose',
    headless: false,
  }

  if (args.debugLevel === 'verbose') {
    chromeArgs.push('--enable-logging=stderr')
    chromeArgs.push('--vmodule=page_graph*=2')
  }

  if (args.extensionsPath !== undefined) {
    chromeArgs.push('--disable-extensions-except=' + args.extensionsPath)
    chromeArgs.push('--load-extension=' + args.extensionsPath)
  }

  if (args.proxyServer != null) {
    chromeArgs.push(`--proxy-server=${args.proxyServer.toString()}`)
    if (args.proxyServer.protocol === 'socks5') {
      const socksProxyRule = '--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE ' + args.proxyServer.hostname
      chromeArgs.push(socksProxyRule)
    }
  }

  if (args.extraArgs != null) {
    chromeArgs.push(...args.extraArgs)
  }

  return {
    launchOptions: puppeteerArgs,
    profilePath,
    shouldClean,
  }
}

const asyncSleep = async (millis: number): Promise<void> => {
  return await new Promise(resolve => setTimeout(resolve, millis))
}

const defaultComputeTimeout = (tryIndex: number): number => {
  return Math.pow(2, tryIndex - 1) * 1000
}

export const launchWithRetry = async (launchOptions: LaunchOptionsType,
                                      logger: Logger,
                                      // eslint-disable-next-line max-len
                                      retryOptions?: LaunchRetryOptions): Promise<ProcessType> => {
  // default to 3 retries with a base-2 exponential-backoff delay
  // between each retry (1s, 2s, 4s, ...)
  const retries: number = retryOptions === undefined
    ? 3
    : +retryOptions.retries
  const computeTimeout = retryOptions !== undefined
    ? retryOptions.computeTimeout
    : defaultComputeTimeout

  try {
    return puppeteerLib.launch(launchOptions)
  }
  catch (err) {
    logger.debug('Failed to launch: ', err, '. ', retries, ' left…')
  }

  for (let i = 1; i <= retries; ++i) {
    await asyncSleep(computeTimeout(i))
    try {
      return puppeteerLib.launch(launchOptions)
    }
    catch (err) {
      logger.debug('Failed to launch: ', err, '. ', (retries - i), ' left…')
    }
  }

  throw new Error(`Unable to launch after ${retries} retries!`)
}
