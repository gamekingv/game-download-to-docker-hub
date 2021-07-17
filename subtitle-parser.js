const fs = require('fs');
const got = require('got');

const client = got.extend({
  timeout: 10000,
  responseType: 'json'
});

function secToTime(sec) {
  let h = Math.trunc(sec / 3600),
    m = Math.trunc((sec - h * 3600) / 60),
    s = sec - h * 3600 - m * 60;
  return `${h < 10 ? '0' : ''}${h}:${m < 10 ? '0' : ''}${m}:${s < 10 ? '0' : ''}${s.toFixed(2)}0`.replace('.', ',');
  // return `${h}:${m < 10 ? '0' : ''}${m}:${s < 10 ? '0' : ''}${s.toFixed(2)}`;
}

function ccToSrt(subs, delay) {
  let srt = '', index = 0;
  // font_name = '思源黑体 Bold',
  // font_size = '95';
  // let ass = `[Script Info]\r\nTitle: ${title}\r\nScriptType: v4.00+\r\nWrapStyle: 0\r\nPlayResX: 1920\r\nPlayResY: 1080\r\nScaledBorderAndShadow: yes\r\nYCbCr Matrix: None\r\n\r\n[Aegisub Project Garbage]\r\nLast Style Storage: Default\r\n\r\n[V4+ Styles]\r\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\r\nStyle: Default,${font_name},${font_size},&H00FFFFFF,&H000000FF,&H00020713,&H00000000,0,0,0,0,100,100,0,0,1,3,0,2,10,10,65,1\r\n\r\n[Events]\r\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\r\n`;
  for (let sub of subs) {
    index++;
    srt += `${index}\r\n${secToTime(sub.from + delay)} --> ${secToTime(sub.to + delay)}\r\n${sub.content.replace(/\n/, '\r\n').replace(/\r\n$/, '')}\r\n\r\n`;
    // ass += `Dialogue: 0,${secToTime(sub.from)},${secToTime(sub.to)},Default,,0,0,0,,${sub.location === 2 ? '' : `{\\an${sub.location}}`}${sub.content.replace(/\n$/, '').replace('\n', '\\N')}\r\n`;
  }
  return srt;
}

(async () => {
  try {
    const subtitles = JSON.parse(fs.readFileSync('subtitles.json'));
    for (const subtitle of subtitles) {
      const { body } = await client.get(subtitle.url);
      const srt = ccToSrt(body.body, subtitle.delay);
      fs.mkdirSync(subtitle.path, { recursive: true });
      fs.writeFileSync(`${subtitle.path}/${subtitle.name}`, srt);
      console.log('成功获取字幕' + subtitle.name);
    }
  }
  catch (error) {
    console.log(error);
    if (error.response && error.response.body) console.log(error.response.body);
    process.exit(1);
  }
})();