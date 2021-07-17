const fs = require('fs');
const fsp = fs.promises;
const got = require('got');

// const [, , id] = process.argv;

let client = got.extend({
  timeout: 5000,
  responseType: 'json',
  hooks: {
    afterResponse: [(response, retryWithMergedOptions) => {
      if (response && response.statusCode === 409 && response.body) {
        const updatedOptions = {
          headers: {
            'X-Transmission-Session-Id': response.headers['X-Transmission-Session-Id'.toLowerCase()]
          }
        };
        client = client.extend(updatedOptions);
        return retryWithMergedOptions(updatedOptions);
      }
      return response;
    }]
  }
});

function mapDirectory(root) {
  const filesArr = [];
  root += '/';
  (function dir(dirpath) {
    const files = fs.readdirSync(dirpath);
    files.forEach((item) => {
      const info = fs.statSync(dirpath + item);
      if (info.isDirectory()) {
        dir(dirpath + item + '/');
      } else {
        filesArr.push(dirpath + item);
      }
    });
  })(root);
  return filesArr;
}

(async () => {
  try {
    const selectedFiles = JSON.parse(await fsp.readFile('download-files.json'));
    const downloadedFiles = mapDirectory('Offline');
    const removeFiles = downloadedFiles.filter(file => !selectedFiles.some(selectedFile => `Offline/${selectedFile.name}` === file));
    if (removeFiles.length > 0) {
      console.log('清理多余文件：');
      for (const file of removeFiles) {
        console.log(file);
        await fsp.unlink(file);
      }
    }

  }
  catch (error) {
    console.log(error);
    process.exit(1);
  }
})();
