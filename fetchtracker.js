const axios = require('axios');
const fs = require('fs');
const stream = require('stream');
const { promisify } = require('util');


(async () => {
  try {
    const { data } = await axios.get('https://ngosang.github.io/trackerslist/trackers_all.txt', { timeout: 10000 });
    fs.appendFile('aria2.conf',
      `\nbt-tracker=${data.split('\n').filter(s => s && s.trim()).join(',')}\n`,
      'utf-8',
      err => { if (err) throw err; }
    );
    console.log('获取tracker成功');
    const finished = promisify(stream.finished);
    const dhtWriter = fs.createWriteStream('dht.dat');
    await axios({
      method: 'get',
      url: 'https://github.com/P3TERX/aria2.conf/raw/master/dht.dat',
      responseType: 'stream',
    }).then(async response => {
      response.data.pipe(dhtWriter);
      return finished(dhtWriter);
    });
    const dht6Writer = fs.createWriteStream('dht6.dat');
    await axios({
      method: 'get',
      url: 'https://github.com/P3TERX/aria2.conf/raw/master/dht6.dat',
      responseType: 'stream',
    }).then(async response => {
      response.data.pipe(dht6Writer);
      return finished(dht6Writer);
    });
    console.log('');
    console.log('获取dht文件成功');
  }
  catch (e) {
    console.log(e.toString());
  }
})();