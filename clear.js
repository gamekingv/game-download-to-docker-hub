const fs = require('fs');
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

async function saveDownloadedList(filename, downloadedList) {
  let content = Buffer.from(downloadedList).toString('base64'),
    timeStamp = Date.now(),
    commitLink = `https://api.github.com/repos/${repository}/commits`,
    configLink = `https://api.github.com/repos/${repository}/contents/${filename}`,
    body = {
      message: `更新于${new Date(timeStamp).toLocaleString()}`,
      content
    },
    headers = {
      'Authorization': `token ${token}`
    };
  const response = await client.get(commitLink, {
    headers
  });
  tree_sha = response.body[0].commit.tree.sha;

  const treeResponse = await client.get(`https://api.github.com/repos/${repository}/git/trees/${tree_sha}`, {
    headers
  });
  const file = treeResponse.body.tree.find(file => file.path === filename);
  body.sha = file.sha;

  await client.put(configLink, {
    headers,
    json: body
  });
}

async function triggerNext() {
  const body = {
    ref: 'main',
    // inputs: {
    //   parent: run_id
    // }
  };
  return await client.post(`https://api.github.com/repos/${repository}/actions/workflows/google-drive-download.yml/dispatches`, {
    headers: {
      'Accept': 'application/vnd.github.v3+json',
      'Authorization': `token ${dispatchToken}`,
    },
    json: body,
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
    const uploadedFiles = JSON.parse(fs.readFileSync('uploaded-list.txt'));
    const files = JSON.parse(fs.readFileSync('google-drive-list.json'));
    const remainFiles = files.filter(file => !uploadedFiles.some(uploadedFile => uploadedFile === `${file.path}/${file.name}`));
    await saveDownloadedList('google-drive-list.json', JSON.stringify(remainFiles, null, 2));
    if (remainFiles.length > 0) {
      console.log(`成功处理 ${uploadedFiles.length} 个文件`);
      console.log(`剩余 ${remainFiles.length} 个文件，将在下一次Actions下载`);
      if (uploadedFiles.length > 25) {
        await triggerNext();
        console.log('成功触发下一次任务');
      }
      else {
        console.log('较多文件下载失败，停止触发下一次任务');
        await cancelWorkflow();
        await new Promise(res => setTimeout(() => res(), 60000));
      }
    }
  }
  catch (error) {
    console.log(error);
    if (error.response && error.response.body) console.log(error.response.body);
    process.exit(1);
  }
})();
