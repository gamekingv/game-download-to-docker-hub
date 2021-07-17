const fs = require('fs').promises;
const child_process = require('child_process');
const { promisify } = require('util');
const exec = promisify(child_process.exec);

const {
  GITHUB_EVENT_PATH
} = process.env;

function processOutput(output, lastIndex = 0) {
  const maxSize = 400 * 1024 * 1024;
  const singleFileMaxSize = 12 * 1024 * 1024 * 1024;
  const [header, result] = output.split('\n===+===========================================================================\n');
  const hash = header.match(/Info Hash:\s*(.*)/)[1];
  const list = result.split('\n---+---------------------------------------------------------------------------\n');
  const filterResult = list.filter(item => !/_____padding_file_\d+_/.test(item));
  filterResult.pop();
  const matchResult = filterResult.map(item => {
    const [, index, name, size] = item.match(/^\s*(\d+)\|(.*)\n\s*\|[^(]+ \(([^)]+)\)$/);
    return { index: Number(index), name, size: Number(size.replace(/,/g, '')) };
  }).filter(item => item.index > Number(lastIndex));
  const queue = [];
  let totalSizeTemp = 0;
  let taskTemp = [];
  const bigFiles = [];
  matchResult.forEach((item, index) => {
    if (item.size > singleFileMaxSize) {
      bigFiles.push(`${item.name}：${(item.size / (1024 * 1024 * 1024)).toFixed(2)}GB`);
      return;
    }
    totalSizeTemp += item.size;
    if (totalSizeTemp >= maxSize) {
      if (taskTemp.length === 0) {
        queue.push([item.index]);
        totalSizeTemp = 0;
        return;
      }
      else {
        queue.push(taskTemp);
        taskTemp = [];
        totalSizeTemp = item.size;
      }
    }
    taskTemp.push(item.index);
    if (index === matchResult.length - 1) queue.push(taskTemp);
  });
  const taskList = queue.map(files => {
    const list = files.reduce((result, file, index) => {
      if (file === files[index + 1] - 1) {
        if (result.charAt(result.length - 1) === ',' || result.length === 0) return result += `${file}`;
        else if (result.charAt(result.length - 1) !== '-') return result += '-';
        else return result;
      }
      else if (result.charAt(result.length - 1) === ',' || result.charAt(result.length - 1) === '-' || result.length === 0) return result += `${file},`;
      else return result += `,${file},`;
    }, '');
    return `${list.slice(0, -1)}`;
  });
  if (bigFiles.length > 0) {
    console.log('以下文件因过大而忽略：');
    console.log(`magnet:?xt=urn:btih:${hash}`);
  }
  bigFiles.forEach(file => console.log(file));
  return taskList;
}

(async () => {
  try {
    const files = await fs.readdir('./');
    const torrent = files.find((item) => /\.torrent$/.test(item));
    const tasks = [];
    if (!torrent) throw '获取种子文件失败';
    const event = JSON.parse(await fs.readFile(GITHUB_EVENT_PATH));
    const {
      file: lastIndex
    } = event.inputs || {};
    const { stdout: output, stderr } = await exec(`aria2c -S "${torrent}"`);
    if (stderr) throw stderr;
    if (output) {
      const list = processOutput(output, lastIndex);
      tasks.push(...list);
    }
    else throw 'Aria2解析种子命令无输出';
    if (!tasks[0]) throw '分解种子任务失败';
    await fs.writeFile('list.txt', `${torrent}\r\n  select-file=${tasks[0]}`);
    const last = tasks[0].match(/[-,]?(\d+)$/)[1];
    if (tasks.length === 1) await fs.writeFile('last-file.txt', 'none');
    else await fs.writeFile('last-file.txt', last);
  }
  catch (error) {
    console.log(error);
    process.exit(1);
  }
})();
