const got = require('got');
const fs = require('fs').promises;

const [, , id, infinity] = process.argv;

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

function formatSize(size, denominator = 1024) {
  if (size < denominator) return `${size} B`;
  else if (size < Math.pow(denominator, 2)) return `${(size / denominator).toFixed(0)} KB`;
  else if (size < Math.pow(denominator, 3)) return `${(size / Math.pow(denominator, 2)).toFixed(2)} MB`;
  else if (size < Math.pow(denominator, 4)) return `${(size / Math.pow(denominator, 3)).toFixed(2)} GB`;
  else if (size < Math.pow(denominator, 5)) return `${(size / Math.pow(denominator, 4)).toFixed(2)} TB`;
  else if (size < Math.pow(denominator, 6)) return `${(size / Math.pow(denominator, 5)).toFixed(2)} PB`;
}

function formatTime(time) {
  if (time <= 0) return 'Unknown';
  let sec, min, hour;
  if (time < 60) sec = time;
  else if (time < 60 * 60) {
    min = Math.floor(time / 60);
    sec = time - min * 60;
  }
  else {
    hour = Math.floor(time / (60 * 60));
    min = Math.floor((time - hour * 60 * 60) / 60);
    sec = time - hour * 60 * 60 - min * 60;
  }
  return `${hour ? `${hour}h` : ''}${min ? `${min}m` : ''}${sec ? `${sec}s` : ''}`;
}

(async () => {
  let timeout = false;
  const timeoutFlag = setTimeout(() => timeout = true, 5 * 60 * 60 * 1000);
  if (infinity) clearTimeout(timeoutFlag);
  try {
    while (!timeout) {
      const { body } = await client.post('http://localhost:9091/transmission/rpc', {
        json: {
          method: 'torrent-get',
          arguments: {
            fields: [
              'id',
              'eta',
              'leftUntilDone',
              'percentDone',
              'rateDownload',
              'sizeWhenDone',
              'error',
              'errorString'
            ],
            ids: [Number(id)]
          }
        }
      });
      const torrent = body.arguments.torrents[0];
      if (!torrent) throw '监视种子失败';
      const { eta, rateDownload, percentDone, leftUntilDone, sizeWhenDone, error, errorString } = torrent;
      console.log(`${formatSize(sizeWhenDone - leftUntilDone)} / ${formatSize(sizeWhenDone)} (${(percentDone * 100).toFixed(2)}%)  Speed: ${formatSize(rateDownload, 1000)}/s  Remaining: ${formatTime(eta)}`);
      if (error > 0) throw errorString;
      if (percentDone === 1) break;
      await new Promise(res => setTimeout(() => res(), 30 * 1000));
    }
    clearTimeout(timeoutFlag);
    await client.post('http://localhost:9091/transmission/rpc', {
      json: {
        method: 'torrent-stop',
        arguments: {
          ids: [Number(id)]
        },
      }
    });
    let status = 4;
    while (status === 4) {
      const { body } = await client.post('http://localhost:9091/transmission/rpc', {
        json: {
          method: 'torrent-get',
          arguments: {
            fields: [
              'status'
            ],
            ids: [Number(id)]
          }
        }
      });
      const torrent = body.arguments.torrents[0];
      const { status: newStatus } = torrent;
      status = newStatus;
      await new Promise(res => setTimeout(() => res(), 1000));
    }
    if (timeout) await fs.writeFile('download-result.txt', 'timeout');
    else await fs.writeFile('download-result.txt', 'complete');
  }
  catch (error) {
    console.log(error);
    if (error.response && error.response.body) console.log(error.response.body);
    clearTimeout(timeoutFlag);
    process.exit(1);
  }
})();