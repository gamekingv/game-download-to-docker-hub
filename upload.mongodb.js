const axios = require('axios');
const fs = require('fs');
const crypto = require('crypto');
const { MongoClient } = require('mongodb');
const { promisify } = require('util');
const stream = require('stream');
const got = require('got');
const pipeline = promisify(stream.pipeline);

const {
  QUEUE_DD_URL: repositoryUrl,
  QUEUE_DD_USERNAME: username,
  QUEUE_DD_PASSWORD: password,
  GITHUB_WORKFLOW: workflow_name,
  QUEUE_DB_HOST: db_host,
  QUEUE_DB_USERNAME: db_username,
  QUEUE_DB_PASSWORD: db_password
} = process.env;


const db_name = 'docker_drive';
const uri = `mongodb+srv://${db_username}:${db_password}@${db_host}/${db_name}?retryWrites=true&w=majority`;
const client = new MongoClient(uri, { useNewUrlParser: true, useUnifiedTopology: true });
const collection_name = repositoryUrl;
let collection;

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
    console.log(error.response.data);
  }
  else console.log(`请求出错：${error.toString()}`);
  config.__retryCount = config.__retryCount || 0;
  if (config.__retryCount >= preset.retry) return await Promise.reject(error);
  config.__retryCount += 1;
  const additional_time = error.response && error.response.status === 400 ? config.__retryCount * 30000 : 0;
  await new Promise(res => setTimeout(() => res(''), config.__retryCount * 2000 + additional_time));
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
  await pipeline(
    fs.createReadStream(path),
    got.stream.put(`${url}&digest=${digest}`, {
      headers: {
        'Content-Type': 'application/octet-stream',
        'repository': [server, namespace, image].join('/'),
        'Content-Length': size,
        'Authorization': `Bearer ${repository.token}`
      }
    })
  );
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

async function upload(path, digest, size, retryCount = 0) {
  if (retryCount === 0) console.log('开始上传文件');
  const start = Date.now();
  try {
    await uploadFile(path, digest, size);
    console.log('文件上传完成');
    console.log('上传用时：' + timeFormatter(Date.now() - start));
  }
  catch (error) {
    console.log(path + ' 上传出错：');
    if (error.response) {
      console.log('HTTP状态码：' + error.response.statusCode);
    }
    else console.log(error.toString());
    if (retryCount < 3) {
      retryCount++;
      console.log(`开始第 ${retryCount} 次重试上传`);
      await upload(path, digest, size, retryCount);
    }
    else throw error;
  }
}

async function add(paths, item) {
  const timestamp = Date.now();
  const id = await paths.reduce(async (parent_id, path) => {
    const { value } = await collection.findOneAndUpdate({
      name: path,
      parent: await parent_id
    }, {
      $set: {
        uploadTime: timestamp,
        type: 'folder',
      }
    }, {
      projection: {
        _id: 1
      },
      upsert: true,
      returnOriginal: false
    });
    return value._id;
  }, null);
  if (item.type === 'folder') {
    await collection.findOneAndUpdate({
      name: item.name,
      parent: id
    }, {
      $set: {
        uploadTime: timestamp,
        type: 'folder',
      }
    }, {
      upsert: true
    });
  }
  else {
    if (await collection.countDocuments({ name: item.name, parent: id, digest: item.digest }) > 0) return;
    let final_name = item.name, index = 0;
    let [, name, ext] = item.name.match(/(.*)(\.[^.]*)$/) || [];
    if (!name) {
      name = item.name;
      ext = '';
    }
    while (await collection.countDocuments({ name: final_name, parent: id }) > 0) {
      if (await collection.countDocuments({ name: final_name, parent: id, digest: item.digest }) > 0) return;
      final_name = `${name} (${++index})${ext}`;
    }
    await collection.insertOne(Object.assign(item, { name: final_name, parent: id, uploadTime: timestamp }));
  }
}

function parse(array) {
  const mark = {};
  const root = [];
  array.forEach(item => {
    mark[item._id] = item;
    item.id = Symbol();
    if (item.type === 'folder') item.files = [];
  });
  array.forEach(item => {
    if (item.parent === null) root.push(item);
    else mark[item.parent].files.push(item);
    delete item.parent;
  });
  const files = new Set();
  array.forEach(item => item.type === 'file' ? files.add(`${item.digest}|${item.size}`) : '');
  const layers = Array.from(files).map(file => {
    const [digest, size] = file.split('|');
    return {
      mediaType: 'application/vnd.docker.image.rootfs.diff.tar.gzip',
      digest, size: Number(size)
    };
  });
  return { files: root, layers };
}

async function synchronize() {
  console.log('');
  console.log('开始同步数据库配置到docker');
  const array = await collection.find().toArray();
  const config = parse(array);
  await commit(config);
  console.log('同步数据库配置成功');
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
  if (!fs.existsSync('Offline')) return console.log('无文件需要上传');
  const files = mapDirectory('Offline');
  await client.connect();
  collection = client.db(db_name).collection(collection_name);
  const { layers } = await getManifests();
  let uploadedCount = 0;
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
      if (layers.some(e => e.digest === digest)) console.log('文件已存在');
      else await upload(file, digest, size);
      console.log('开始上传配置到数据库');
      const paths = file.split('/');
      const filename = paths.pop();
      await add(paths, {
        name: filename,
        type: 'file',
        digest,
        size
      });
      console.log('上传完成');
      console.log('总用时：' + timeFormatter(Date.now() - start));
      layers.push({
        digest,
        mediaType: 'application/vnd.docker.image.rootfs.diff.tar.gzip',
        size
      });
      uploadedCount++;
      if (uploadedCount >= 50) {
        await synchronize();
        uploadedCount = 0;
      }
    }
    catch (e) {
      console.log(e.toString());
    }
    console.log('');
  }
  try {
    if (uploadedCount > 0) {
      await synchronize();
      uploadedCount = 0;
    }
  }
  catch (error) {
    console.log(error);
    if (error.response && error.response.body) console.log(error.response.body);
    process.exit(1);
  }
  await client.close();
})();
