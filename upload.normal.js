const axios = require('axios');
const fs = require('fs');
const crypto = require('crypto');
const request = require('request');

const {
  QUEUE_DD_URL: repositoryUrl,
  QUEUE_DD_USERNAME: username,
  QUEUE_DD_PASSWORD: password,
  GITHUB_WORKFLOW: workflow_name
} = process.env;

const [server, namespace, image] = repositoryUrl.split('/');
const secret = new Buffer.from(`${username}:${password}`).toString('base64');
const repository = {
  token: '',
  secret,
  server,
  namespace,
  image
};

const ignoreFilters = [
  '_____padding_file',
  /\.torrent$/,
  /\.aria2$/
];

const preset = {
  retry: 3,
  timeout: 10000
};

async function errorHandler(error) {
  const config = error.config;
  if (error.response) {
    if (!config || [401, 404, 504].some(status => error.response.status === status)) return await Promise.reject(error);
    console.log('请求出错，HTTP状态码：' + error.response.status);
  }
  else console.log(`请求出错：${error.toString()}`);
  config.__retryCount = config.__retryCount || 0;
  if (config.__retryCount >= preset.retry) return await Promise.reject(error);
  config.__retryCount += 1;
  await new Promise(res => setTimeout(() => res(''), 1000));
  console.log(`第 ${config.__retryCount} 次重试请求`);
  return await axios(config);
}

axios.defaults.timeout = preset.timeout;
axios.interceptors.response.use(undefined, errorHandler);
axios.defaults.maxContentLength = Infinity;
axios.defaults.maxBodyLength = Infinity;

async function requestSender(url, instance) {
  instance.interceptors.response.use(undefined, errorHandler);
  if (repository.token) instance.defaults.headers.common['Authorization'] = `Bearer ${repository.token}`;
  try {
    return await instance.request({ url });
  }
  catch (error) {
    if (!error.response) throw error;
    const { status, headers } = error.response;
    if (status === 401) {
      try {
        const token = await getToken(headers['www-authenticate']);
        if (token) {
          repository.token = token;
          instance.defaults.headers.common['Authorization'] = `Bearer ${repository.token}`;
        }
        else throw '获取token失败';
        return await instance.request({ url });
      }
      catch (error) {
        if (!error.response) throw error;
        const { status } = error.response;
        if (status === 401) throw '账号或密码错误';
        else throw error;
      }
    }
    throw error;
  }
}

async function getToken(authenticateHeader) {
  if (!authenticateHeader) throw '获取token失败';
  const [, realm, service, , scope] = authenticateHeader.match(/^Bearer realm="([^"]*)",service="([^"]*)"(,scope="([^"]*)"|)/);
  if (realm && service) {
    let authenticateURL = `${realm}?service=${service}`;
    if (scope) authenticateURL += `&scope=${scope}`;
    const headers = {};
    if (repository.secret) headers['Authorization'] = `Basic ${repository.secret}`;
    const { data } = await axios.get(authenticateURL, { headers, timeout: 5000 });
    return data.token;
  }
  else throw '获取token失败';
}

async function getUploadURL() {
  const { server, namespace, image } = repository;
  const instance = axios.create({
    method: 'post',
    headers: {
      'repository': [server, namespace, image].join('/')
    }
  });
  const url = `https://${server}/v2/${namespace}/${image}/blobs/uploads/`;
  const { headers } = await requestSender(url, instance);
  if (headers['location']) return headers['location'];
  else throw '获取上传链接失败';
}

async function uploadConfig(config) {
  const { server, namespace, image } = repository;
  const size = config.length;
  const hash = crypto.createHash('sha256').update(config);
  const digest = `sha256:${hash.digest('hex').toString()}`;
  const url = await getUploadURL();
  const instance = axios.create({
    method: 'put',
    headers: {
      'Content-Type': 'application/octet-stream',
      'repository': [server, namespace, image].join('/'),
      'Content-Length': size
    },
    timeout: 0
  });
  instance.interceptors.request.use(e => Object.assign(e, {
    data: Buffer.from(config, 'utf8')
  }));
  await requestSender(`${url}&digest=${digest}`, instance);
  return { digest, size };
}

async function uploadFile(path, digest, size) {
  const { server, namespace, image } = repository;
  const url = await getUploadURL();
  await new Promise((res, rej) => {
    fs.createReadStream(path).pipe(request({
      url: `${url}&digest=${digest}`,
      method: 'PUT',
      headers: {
        'Content-Type': 'application/octet-stream',
        'repository': [server, namespace, image].join('/'),
        'Content-Length': size,
        'Authorization': `Bearer ${repository.token}`
      }
    }, (error, response) => {
      const result = { response: { status: response.statusCode } };
      if (error) {
        console.log(error.toString());
        rej(result);
      }
      else res(result);
    }));
  });
}

async function commit(config) {
  const { server, namespace, image } = repository;
  const { digest, size } = await uploadConfig(JSON.stringify({ files: config.files }));
  const manifest = {
    schemaVersion: 2,
    mediaType: 'application/vnd.docker.distribution.manifest.v2+json',
    config: {
      mediaType: 'application/vnd.docker.container.image.v1+json',
      size,
      digest
    },
    layers: config.layers
  };
  const url = `https://${server}/v2/${namespace}/${image}/manifests/latest`;
  const instance = axios.create({
    method: 'put',
    headers: {
      'Content-Type': 'application/vnd.docker.distribution.manifest.v2+json',
      'repository': [server, namespace, image].join('/')
    },
  });
  instance.interceptors.request.use(e => Object.assign(e, {
    data: JSON.stringify(manifest)
  }));
  await requestSender(url, instance);
}

function hashFile(path) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const rs = fs.createReadStream(path);
    rs.on('error', reject);
    rs.on('data', chunk => hash.update(chunk));
    rs.on('end', () => resolve(`sha256:${hash.digest('hex')}`));
  });
}

async function getManifests() {
  const { server, namespace, image } = repository;
  const manifestsURL = `https://${server}/v2/${namespace}/${image}/manifests/latest`;
  const manifestsInstance = axios.create({
    method: 'get',
    headers: {
      'Accept': 'application/vnd.docker.distribution.manifest.v2+json',
      'repository': [server, namespace, image].join('/')
    }
  });
  try {
    const { data } = await requestSender(manifestsURL, manifestsInstance);
    const layers = data.layers;
    const digest = data.config.digest;
    if (digest && layers) {
      const configURL = `https://${server}/v2/${namespace}/${image}/blobs/${digest}`;
      const configInstance = axios.create({
        method: 'get',
        headers: {
          'repository': [server, namespace, image].join('/')
        }
      });
      const { data } = await requestSender(configURL, configInstance);
      if (data) return { config: data, layers };
      else throw '加载配置文件失败';
    }
    else throw '加载配置文件失败';
  }
  catch (error) {
    if (error.response) {
      const { status } = error.response;
      if (status === 404) return { config: { files: [] }, layers: [] };
    }
    throw error;
  }
}
function parseConfig(config) {
  let list;
  if (config.fileItems) {
    const cacheRoot = { name: 'root', type: 'folder', files: [], id: Symbol() };
    config.fileItems.forEach(({ name: pathString, size, digest, uploadTime }) => {
      if (!uploadTime) uploadTime = Date.now();
      const path = pathString.substr(1).split('/');
      const type = digest ? 'file' : 'folder';
      let filePointer = cacheRoot;
      const id = Symbol();
      for (let i = 0; i < path.length - 1; i++) {
        const nextPointer = filePointer.files.find(e => e.name === path[i]);
        const id = Symbol();
        if (nextPointer) filePointer = nextPointer;
        else {
          const item = { name: path[i], type: 'folder', files: [], id };
          if (!item.uploadTime || item.uploadTime < uploadTime) item.uploadTime = uploadTime;
          filePointer.files.push(item);
          filePointer = item;
        }
      }
      if (type === 'folder') filePointer.files.push({ name: path[path.length - 1], type, files: [], id });
      else filePointer.files.push({ name: path[path.length - 1], type, size, digest, uploadTime, id });
    });
    list = cacheRoot.files;
  }
  else if (config.files) {
    const addID = (files) => {
      files.forEach(file => {
        file.id = Symbol();
        if (file.files) addID(file.files);
      });
    };
    addID(config.files);
    list = config.files;
  }
  else throw '加载配置文件失败';
  return list;
}

function getPath(pathString, files) {
  const cacheRoot = { name: 'root', type: 'folder', files, id: Symbol() };
  const path = pathString.split('/').map(e => e = { name: e });
  path.unshift('');
  path.pop();
  let filePointer = cacheRoot;
  path.slice(1).forEach(pathNode => {
    let nextPointer = filePointer.files.find(e => e.name === pathNode.name);
    if (!nextPointer) {
      nextPointer = { name: pathNode.name, type: 'folder', id: Symbol(), files: [], uploadTime: Date.now() };
      filePointer.files.push(nextPointer);
    }
    else if (nextPointer.type !== 'folder') {
      let i = 1;
      while (filePointer.files.some(e => e.name === `${pathNode.name} (${i})`)) i++;
      nextPointer = { name: `${pathNode.name} (${i})`, type: 'folder', id: Symbol(), files: [], uploadTime: Date.now() };
      filePointer.files.push(nextPointer);
    }
    filePointer = nextPointer;
  });
  return filePointer.files;
}

async function upload(path, digest, retryCount = 0) {
  if (retryCount === 0) console.log('开始上传文件');
  const start = Date.now();
  try {
    const { layers: testLayers } = await getManifests();
    const size = fs.statSync(path).size;
    let filename = path.split('/').pop();
    if (testLayers.some(e => e.digest === digest)) console.log('文件已存在');
    else {
      await uploadFile(path, digest, size);
      console.log('文件上传完成');
      console.log('上传用时：' + timeFormatter(Date.now() - start));
    }
    console.log('开始上传配置');
    const { config, layers } = await getManifests();
    const files = parseConfig(config);
    const folder = getPath(path, files);
    if (folder.some(e => e.name === filename)) {
      if (layers.some(e => e.digest === digest)) {
        console.log('未更改配置文件');
        return;
      }
      let i = 1;
      let [, name, ext] = filename.match(/(.*)(\.[^.]*)$/);
      if (!name) {
        name = filename;
        ext = '';
      }
      while (folder.some(e => e.name === `${name} (${i})${ext}`)) {
        i++;
      }
      filename = `${name} (${i})${ext}`;
    }
    folder.push({ name: filename, digest, size, type: 'file', uploadTime: Date.now(), id: Symbol() });
    if (!layers.some(e => e.digest === digest))
      layers.push({ mediaType: 'application/vnd.docker.image.rootfs.diff.tar.gzip', digest, size });
    await commit({ files, layers });
    console.log('配置上传完成');
  }
  catch (error) {
    console.log(path + ' 上传出错：');
    if (error.response) {
      console.log('HTTP状态码：' + error.response.status);
    }
    else console.log(error.toString());
    if (retryCount < 3) {
      retryCount++;
      console.log(`开始第 ${retryCount} 次重试上传`);
      await upload(path, digest, retryCount);
    }
  }
}

function sizeFormatter(fileSize) {
  if (typeof fileSize !== 'number') return '-';
  else if (fileSize < 1024) {
    return `${fileSize.toFixed(2)}B`;
  } else if (fileSize < (1024 * 1024)) {
    return `${(fileSize / 1024).toFixed(2)}KB`;
  } else if (fileSize < (1024 * 1024 * 1024)) {
    return `${(fileSize / (1024 * 1024)).toFixed(2)}MB`;
  } else {
    return `${(fileSize / (1024 * 1024 * 1024)).toFixed(2)}GB`;
  }
}

function timeFormatter(time) {
  time = time / 1000;
  let timeString = '';
  if (time < 60) timeString = `${time.toFixed(0)} 秒`;
  else if (time < 60 * 60) {
    const m = Math.floor(time / 60);
    const s = Math.round((time - 60 * m) % 60);
    timeString = `${m} 分钟`;
    if (s > 0) timeString += ` ${s} 秒`;
  }
  else {
    const h = Math.floor(time / (60 * 60));
    const m = Math.floor((time - h * 60 * 60) / 60);
    const s = Math.round(time - h * 60 * 60 - m * 60);
    timeString += `${h} 小时`;
    if (s > 0 || m > 0) {
      timeString += ` ${m} 分钟`;
      if (s > 0) timeString += ` ${s} 秒`;
    }
  }
  return timeString;
}

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
  if(!fs.existsSync('Offline')) return console.log('无文件需要上传');
  const files = mapDirectory('Offline');
  if (workflow_name === 'decompression-download') ignoreFilters.push(/\.zip$/, /\.rar$/);
  for (const file of files) {
    if (ignoreFilters.some(filter => file.match(filter))) {
      console.log('跳过文件：' + file);
      console.log('');
      continue;
    }
    try {
      console.log('开始校验文件：' + file);
      const start = Date.now();
      const digest = await hashFile(file);
      console.log(digest);
      console.log('校验完成，用时：' + timeFormatter(Date.now() - start));
      const size = fs.statSync(file).size;
      console.log(`文件大小：${sizeFormatter(size)}（${size}）`);
      if (digest === 'sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855') throw '空文件';
      await upload(file, digest);
      console.log('总用时：' + timeFormatter(Date.now() - start));
    }
    catch (e) {
      console.log(e.toString());
    }
    console.log('');
  }
})();
