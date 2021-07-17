const fs = require('fs').promises;

(async () => {
  try {
    const settings = JSON.parse(await fs.readFile('/etc/transmission-daemon/settings.json'));
    Object.assign(settings, {
      'download-dir': `${__dirname}/Offline`,
      'rpc-authentication-required': 0,
      'umask': 0
    });
    await fs.writeFile('/etc/transmission-daemon/settings.json', JSON.stringify(settings, null, 2));
  }
  catch (error) {
    console.log(error);
    process.exit(1);
  }
})();