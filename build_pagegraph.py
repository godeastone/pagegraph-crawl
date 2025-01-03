import argparse
import math
import os
import shutil
import signal
from multiprocessing import Pool
from subprocess import PIPE
from subprocess import Popen
from subprocess import TimeoutExpired
from urllib.parse import urlparse


class PortError(Exception):
  def __init__(self, port_idx):
    self.message = '%d is an unsupported port index!' % port_idx
    super().__init__(self.message)


def get_args():
  parser = argparse.ArgumentParser()
  parser.add_argument('-b', required=True,
                      help='Path to the brave browser')
  parser.add_argument('-o', required=True,
                      help='Path to save the PageGraph data')
  parser.add_argument('-j', type=int, required=True,
                      help='# of jobs')
  parser.add_argument('-t', type=int, required=True,
                      help='Timeout in seconds')
  parser.add_argument('--map-local-file', required=True,
                      help='Path to the mapping file')
  return parser.parse_args()


def read_file(path):
  with open(path, 'r') as f:
    c = [x.strip() for x in f.readlines()]
  return c


def get_domain_name(html_path):
  html_name = os.path.basename(html_path)
  return html_name[:-5]


def get_target_urls(mapping_file_path):
  target_urls = []
  for x in read_file(mapping_file_path):
    html_path, target_url = x.split(',')
    if os.path.exists(html_path):
      target_urls += [(target_url, html_path)]
  return target_urls


def filter_finished(target_urls):
  filterd_target_urls = []
  for target_url, html_path in target_urls:
    domain_name = get_domain_name(html_path)
    graph_path = os.path.join(output_path, domain_name, domain_name + '.graphml')
    if not os.path.exists(graph_path):
      filterd_target_urls += [(target_url, html_path, graph_path)]
  return filterd_target_urls


def hasError(log):
  return (
    'new Error(\'Page crashed!\')' in log or
    'ERR_HTTP_RESPONSE_CODE_FAILURE' in log or
    'DEBUG:ERROR' in log
  )


def build_pagegraph(port_idx):
  env = os.environ.copy()
  if port_idx < 10:
    env['http_proxy'] =' http://localhost:800' + str(port_idx)
    env['https_proxy'] =' https://localhost:800' + str(port_idx)
  elif port_idx < 100:
    env['http_proxy'] =' http://localhost:80' + str(port_idx)
    env['https_proxy'] =' https://localhost:80' + str(port_idx)
  elif port_idx < 1000:
    env['http_proxy'] =' http://localhost:8' + str(port_idx)
    env['https_proxy'] =' https://localhost:8' + str(port_idx)
  else:
    raise PortError(port_idx)
  env['no_proxy'] = 'localhost,127.0.0.1'

  num_targets_per_job = math.ceil(len(target_urls) / num_jobs)
  start_idx = (port_idx - 1) * num_targets_per_job
  end_idx = port_idx * num_targets_per_job
  for target_url, html_path, graph_path in target_urls[start_idx:end_idx]:
    output_dir = os.path.dirname(graph_path)
    os.makedirs(output_dir, exist_ok=True)
    cmd = [
      'npm', 'run', 'crawl', '--',
      '-b', browser_path, '-u', target_url, '-o', graph_path,
      '-x', '["--no-sandbox"]'
    ]
    print(' '.join(cmd))
    proc = Popen(cmd, stdout=PIPE, stderr=PIPE, env=env, preexec_fn=os.setsid)
    try:
      stdout, stderr = proc.communicate(timeout=timeout)
      log = '\n'.join([stdout.decode('utf-8'), stderr.decode('utf-8')])
    except TimeoutExpired:
      os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
      f = open(graph_path, 'w')
      f.close()
      continue

    # Create an empty graph file if graph creation fails
    if hasError(log):
      f = open(graph_path, 'w')
      f.close()


if __name__ == '__main__':
  args = get_args()
  browser_path = args.b
  output_path = args.o
  num_jobs = args.j
  timeout = args.t
  target_urls = get_target_urls(args.map_local_file)
  target_urls = filter_finished(target_urls)
  p = Pool(num_jobs)
  p.map(build_pagegraph, range(1, num_jobs + 1))
