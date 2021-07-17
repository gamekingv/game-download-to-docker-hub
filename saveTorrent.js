const fs = require('fs').promises;

const {
  GITHUB_EVENT_PATH
} = process.env;


(async () => {
  try {
    const event = JSON.parse(await fs.readFile(GITHUB_EVENT_PATH));
    const {
      torrent
    } = event.inputs || {};
    const torrentBuffer = Buffer.from(torrent, 'base64');
    fs.writeFile('dispatch.torrent', torrentBuffer);
  }
  catch (error) {
    console.log(error);
    process.exit(1);
  }
})();