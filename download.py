import os
import json
import gdown

with open('./google-drive-list.json','r',encoding='utf8') as file_list:
  files = json.load(file_list)[:30]
  for file in files:
    os.makedirs(file['path'], exist_ok=True)
    gdown.download(file['url'], '{0}/{1}'.format(file['path'], file['name']), quiet=False)
