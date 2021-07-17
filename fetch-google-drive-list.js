const fs = require('fs');
const request = require('request');

const [, , api_key] = process.argv;
const folder = 'Offline/Anime';
const output = 'output.txt';

const root_folder_id = '1yGfiA5Qo5Bs8zDoGSLERdNNZxzeD0nXr';

const download_link_prefix = 'https://drive.google.com/uc?export=download&id=';
const apiRequest = request.defaults({
  baseUrl: 'https://www.googleapis.com',
  //proxy: 'http://localhost:10000'
});

function retryRequest(url, options, retryCount = 0) {
  return new Promise((res, rej) => {
    apiRequest(url, options, async (error, response) => {
      if (error) {
        if (retryCount < 3) {
          await new Promise(res => setTimeout(() => res(), 1000));
          try {
            res(await retryRequest(url, options, retryCount++));
          }
          catch (error) {
            rej(error);
          }
        }
        else rej(error);
      }
      else res(response);
    });
  });
};

const all_files = [];

async function getFolderInfo(id, folder_name) {
  const response = await retryRequest('/drive/v3/files', {
    qs: {
      q: `'${id}' in parents`,
      fields: 'files(id, mimeType, name)',
      pageSize: 1000,
      key: api_key
    }
  });
  const { files } = JSON.parse(response.body);
  for (const file of files) {
    if (file.name.includes('1970-2019') || file.name.includes('BDMV') || file.name.includes('CERTIFICATE') || file.name.toLowerCase().includes('iso')) continue;
    else if (file.mimeType === 'application/vnd.google-apps.folder') await getFolderInfo(file.id, `${folder_name}/${file.name}`);
    else {
      all_files.push({
        url: `${download_link_prefix}${file.id}`,
        name: file.name,
        path: folder_name
      });
      console.log(`添加文件${folder_name}/${file.name}`);
    }
  }
}

(async () => {
  try {
    await getFolderInfo(root_folder_id, folder);
    fs.writeFileSync(output, JSON.stringify(all_files, null, 2));
  }
  catch (error) {
    console.log(error);
    process.exit(1);
  }
})();
