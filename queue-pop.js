const got = require('got');
const { MongoClient, ObjectID } = require('mongodb').MongoClient;

const {
  GITHUB_REPOSITORY: repository,
  QUEUE_DISPATCH_TOKEN: dispatchToken,
  GITHUB_RUN_ID: run_id,
  QUEUE_DB_HOST: db_host,
  QUEUE_DB_USERNAME: db_username,
  QUEUE_DB_PASSWORD: db_password
} = process.env;

const db_name = 'github_action';
const collection_name = 'queue';
const uri = `mongodb+srv://${db_username}:${db_password}@${db_host}/${db_name}?retryWrites=true&w=majority`;

const client = got.extend({
  headers: {
    'User-Agent': 'Github Actions'
  },
  timeout: 10000,
  responseType: 'json'
});

async function getQueue() {
  const client = new MongoClient(uri, { useNewUrlParser: true, useUnifiedTopology: true });
  await client.connect();
  const collection = client.db(db_name).collection(collection_name);
  const result = await collection.find({}).toArray();
  await client.close();
  return result;
}

async function executeTask({ name, list }) {
  const body = JSON.stringify({
    ref: 'main',
    inputs: {
      type: 'queue-execute',
      list,
      parent: run_id
    }
  });
  await client.post(`https://api.github.com/repos/${repository}/actions/workflows/${name}.yml/dispatches`, {
    headers: {
      'Accept': 'application/vnd.github.v3+json',
      'Authorization': `token ${dispatchToken}`
    },
    body,
  });
}

(async () => {
  try {
    const queue = await getQueue();
    if (queue && queue.length > 0) {
      const task = queue.shift();
      await executeTask(task);
      const client = new MongoClient(uri, { useNewUrlParser: true, useUnifiedTopology: true });
      await client.connect();
      const collection = client.db(db_name).collection(collection_name);
      await collection.deleteOne({ _id: new ObjectID(task._id) });
      await client.close();
      console.log('已触发下一个队列任务');
      console.log(`任务类型：${task.name}`);
      if (task.list) console.log(`列表：${task.list}`);
    }
    else console.log('队列中已无任务');
  }
  catch (error) {
    console.log(error);
    if (error.response && error.response.body) console.log(error.response.body);
    process.exit(1);
  }
})();
