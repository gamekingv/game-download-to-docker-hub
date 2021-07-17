const fs = require('fs').promises;
const got = require('got');

const {
  GITHUB_REPOSITORY: repository,
  GITHUB_RUN_ID: run_id,
  QUEUE_TOKEN: token,
  QUEUE_DISPATCH_TOKEN: dispatchToken
} = process.env;

const client = got.extend({
  headers: {
    'User-Agent': 'Github Actions'
  },
  timeout: 10000,
  responseType: 'json'
});

async function executeTask({ torrent, file }) {
  await client.post(`https://api.github.com/repos/${repository}/actions/workflows/big-torrent-download.yml/dispatches`, {
    headers: {
      'Accept': 'application/vnd.github.v3+json',
      'Authorization': `token ${dispatchToken}`
    },
    json: {
      ref: 'main',
      inputs: {
        type: 'magnet',
        torrent,
        file
      }
    },
  });
}

async function cancelWorkflow() {
  await client.post(`https://api.github.com/repos/${repository}/actions/runs/${run_id}/cancel`, {
    headers: {
      'Accept': 'application/vnd.github.v3+json',
      'Authorization': `token ${token}`
    }
  });
}

(async () => {
  try {
    const list = (await fs.readFile('list.txt')).toString();
    const magnet = list.match(/(.*)/)[1];
    const lastIndex = `${await fs.readFile('last-file.txt')}`;
    if (lastIndex === 'none') {
      console.log('无后续任务');
      await cancelWorkflow();
      await new Promise(res => setTimeout(() => res(), 60000));
    }
    else await executeTask({ torrent: magnet, file: lastIndex });
  }
  catch (error) {
    console.log(error);
    if (error.response && error.response.body) console.log(error.response.body);
    process.exit(1);
  }
})();
