const axios = require('axios');
const fs = require('fs');
const qs = require('qs');
const crypto = require('crypto');
const { promisify } = require('util');
const stream = require('stream');
const got = require('got');
const pipeline = promisify(stream.pipeline);

const {
  QUEUE_DD_URL: repositoryUrl,
  QUEUE_DD_USERNAME: username,
  QUEUE_DD_PASSWORD: password,
  GITHUB_WORKFLOW: workflow_name,
  QUEUE_DB_URL: db_url,
  QUEUE_DB_APIKEY: db_apikey
} = process.env;


const [server, namespace, image] = repositoryUrl.split('/');
const secret = new Buffer.from(`${username}:${password}`).toString('base64');
const repository = {
  token: '',
  secret,
  server,
  namespace,
  image,
  databaseURL: db_url,
  databaseToken: {
    token: '',
    apikey: db_apikey,
    expiration: 0
  }
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
    if (!config || [401, 404, 409, 504].some(status => error.response.status === status)) {
      return await Promise.reject(error);
    }
    console.log('请求出错，HTTP状态码：' + error.response.status);
    console.log(JSON.stringify(error.response.data, null, 2));
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

const client = axios.create({
  timeout: 60000
});
client.interceptors.response.use(undefined, errorHandler);

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

async function getDatabaseToken(secret) {
  const { data } = await axios.post('https://iam.cloud.ibm.com/identity/token', qs.stringify({
    'grant_type': 'urn:ibm:params:oauth:grant-type:apikey',
    'apikey': secret
  }), {
    headers: {
      'Accept': 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded'
    }
  });
  return { token: data.access_token, expiration: data.expiration };
}

async function setToken() {
  if (!repository.databaseToken) return;
  const now = Date.now() / 1000;
  if (now >= repository.databaseToken.expiration - 60) {
    const { token, expiration } = await getDatabaseToken(repository.databaseToken.apikey);
    repository.databaseToken.token = token;
    repository.databaseToken.expiration = expiration;
    client.defaults.headers.common['Authorization'] = `Bearer ${repository.databaseToken.token}`;
  }
}

async function search(name, parent) {
  await setToken(repository);
  const databaseName = repositoryUrl.replace(/\//g, '-').replace(/\./g, '_');
  const { data } = await client.post(`${repository.databaseURL}/${databaseName}/_partition/${parent}/_find`, {
    selector: {
      name: { $eq: name }
    },
    fields: ['_id', 'name', 'type', 'digest', 'size', 'uploadTime', 'uuid'],
  }, {
    headers: {
      'Content-Type': 'application/json'
    }
  });
  return data.docs;
}

async function update(item, parent) {
  await setToken(repository);
  const databaseName = repositoryUrl.replace(/\//g, '-').replace(/\./g, '_');
  delete item.files;
  if (item._id) {
    const [parentID, id] = item._id.split(':');
    const isModifyName = id !== `${crypto.createHash('md5').update(item.name).digest('hex')}`, isModifyParent = parentID !== parent;
    try {
      if (isModifyName || isModifyParent) {
        item._id = `${parent}:${crypto.createHash('md5').update(item.name).digest('hex')}`;
      } else {
        const { headers } = await client.head(`${repository.databaseURL}/${databaseName}/${item._id}`);
        if (headers['etag']) item._rev = headers['etag'].replace(/.*"([^"]+)".*/, '$1');
        else throw '';
      }
    }
    catch (error) {
      throw `"${item.name}" doesn't exist`;
    }
    try {
      const { data } = await client.post(`${repository.databaseURL}/${databaseName}`, item, {
        headers: {
          'Content-Type': 'application/json'
        }
      });
      return item.type === 'file' ? data.id.split(':')[1] : item.uuid;
    }
    catch (error) {
      if (error.response) {
        if (error.response.status === 409 && error.response.data.error === 'conflict') {
          if (!isModifyName && !isModifyParent) {
            const { headers } = await client.head(`${repository.databaseURL}/${databaseName}/${item._id}`);
            if (headers['etag']) item._rev = headers['etag'].replace(/.*"([^"]+)".*/, '$1');
            else throw error;
            const { data } = await client.post(`${repository.databaseURL}/${databaseName}`, item, {
              headers: {
                'Content-Type': 'application/json'
              }
            });
            return item.type === 'file' ? data.id.split(':')[1] : item.uuid;
          }
        }
      }
      throw error;
    }
  }
  else {
    if (item.type === 'folder') {
      const { data } = await client.get(`${repository.databaseURL}/_uuids`);
      item.uuid = data.uuids[0];
    }
    item._id = `${parent}:${crypto.createHash('md5').update(item.name).digest('hex')}`;
    try {
      const { data } = await client.post(`${repository.databaseURL}/${databaseName}`, item, {
        headers: {
          'Content-Type': 'application/json'
        }
      });
      return item.type === 'file' ? data.id.split(':')[1] : item.uuid;
    }
    catch (error) {
      if (error.response && error.response.status === 409 && error.response.data.error === 'conflict') {
        if (item.type === 'folder') return item.uuid;
        else {
          let finalName = item.name, finalId = item._id, index = 0, exist = true;
          let [, name, ext] = item.name.match(/(.*)(\.[^.]*)$/) || [];
          if (!name) {
            name = item.name;
            ext = '';
          }
          while (exist) {
            finalName = `${name} (${++index})${ext}`;
            try {
              const { data } = await client.get(`${repository.databaseURL}/${databaseName}/${finalId}`);
              if (data.digest === item.digest) throw '文件已存在';
              finalId = `${parent}:${crypto.createHash('md5').update(item.name).digest('hex')}`;
              await client.post(`${repository.databaseURL}/${databaseName}`, Object.assign(item, { _id: finalId, name: finalName }), {
                headers: {
                  'Content-Type': 'application/json'
                }
              });
              exist = false;
              return finalId.split(':')[1];
            }
            catch (error) {
              if (error.response && error.response.status !== 409 || error.response.data.error !== 'conflict') throw error;
            }
          }
        }
      }
      throw error;
    }
  }
}

async function add(paths, item) {
  const parent = await paths.reduce(async (parentId, path) => {
    const [folder] = await search(path, await parentId);
    if (folder) {
      folder.uploadTime = item.uploadTime;
      return await update(folder, await parentId);
    }
    else return await update({
      id: Symbol(),
      name: path,
      type: 'folder',
      uploadTime: item.uploadTime
    }, await parentId);
  }, 'root');
  await update(item, parent);
}

async function list() {
  await setToken(repository);
  const databaseName = repositoryUrl.replace(/\//g, '-').replace(/\./g, '_');
  const { data } = await client.post(`${repository.databaseURL}/${databaseName}/_find`, {
    selector: { _id: { $gt: '0' } },
    fields: ['_id', 'name', 'type', 'digest', 'size', 'uploadTime', 'uuid'],
    sort: [{ uploadTime: 'desc' }]
  }, {
    headers: {
      'Content-Type': 'application/json'
    }
  });
  return parse(data.docs);
}

function parse(array) {
  const mark = {};
  const root = [];
  array.forEach(item => {
    item.id = Symbol();
    if (item.type === 'folder') {
      mark[item.uuid] = item;
      item.files = [];
    }
  });
  array.forEach(item => {
    const [parent] = item._id.split(':');
    if (parent === 'root') root.push(item);
    else mark[parent].files.push(item);
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
  const config = await list();
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
  const { layers } = await getManifests();
  const uploadedFiles = [];
  let uploadedCount = 0;
  if (workflow_name === 'decompression-download') ignoreFilters.push(/\.zip$/, /\.rar$/);
  for (const file of files) {
    if (ignoreFilters.some(filter => file.match(filter))) {
      console.log('跳过文件：' + file);
      console.log('');
      uploadedFiles.push(file);
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
        size,
        uploadTime: Date.now()
      });
      console.log('上传完成');
      console.log('总用时：' + timeFormatter(Date.now() - start));
      layers.push({
        digest,
        mediaType: 'application/vnd.docker.image.rootfs.diff.tar.gzip',
        size
      });
      uploadedFiles.push(file);
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
  fs.writeFileSync('uploaded-list.txt', JSON.stringify(uploadedFiles));
  try {
    if (uploadedCount > 0) {
      await synchronize();
      uploadedCount = 0;
    }
  }
  catch (error) {
    console.log(error);
    if (error.response && error.response.data) console.log(JSON.stringify(error.response.data, null, 2));
    process.exit(1);
  }
})();
