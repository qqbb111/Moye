import regular from '../assets/fonts/SourceCodePro-Regular.woff2?inline';
import bold from '../assets/fonts/SourceCodePro-Bold.woff2?inline';
import italic from '../assets/fonts/SourceCodePro-It.woff2?inline';

// Standalone exports carry their fonts; they never point into an installed app.
export default `
@font-face{font-family:'Source Code Pro';font-weight:400;src:url('${regular}') format('woff2')}
@font-face{font-family:'Source Code Pro';font-weight:700;src:url('${bold}') format('woff2')}
@font-face{font-family:'Source Code Pro';font-weight:400;font-style:italic;src:url('${italic}') format('woff2')}
body{box-sizing:border-box;background:#1f1f1f;color:#e9e9e9;font:16px/1.7 -apple-system,BlinkMacSystemFont,'PingFang SC','Microsoft YaHei','微软雅黑',Helvetica,Arial,'Segoe UI',sans-serif;max-width:900px;margin:0 auto;padding:32px 48px 96px}
h1,h2,h3,h4,h5,h6{border:0;margin:24px 0 8px;padding:0;color:#ffffffe6;font-weight:600;line-height:1.4}
body>:first-child,article>:first-child{margin-top:0}h1{font-size:26px}h2{font-size:22px}h3{font-size:18px}h4,h5,h6{font-size:16px;line-height:1.5}h6{color:#ffffff80}
p{margin:0 0 12px}strong{font-weight:600}a{color:#0088ff;text-decoration:none}
blockquote{margin:12px 0;padding:2px 0 2px 14px;border-left:3px solid #ffffff26;color:#ffffff80}blockquote p:last-child{margin-bottom:0}
code{font-family:'Source Code Pro',Consolas,monospace}:not(pre)>code{font-size:93%;padding:.15em .35em;border-radius:4px;background:#c8c8c826;color:#ffffffe6}
pre.wb-code{position:relative;margin:12px 0;padding:10px 16px 10px 44px;border:1px solid #ffffff1f;border-radius:10px;background:#1e1e1e;font:400 14px/1.7 'Source Code Pro',Consolas,monospace;tab-size:4;white-space:normal}
pre.wb-code code{display:block;counter-reset:line;color:#e1e4e8;font:inherit;white-space:normal}
pre.wb-code .line{position:relative;display:block;counter-increment:line;min-height:1.7em;white-space:pre-wrap;overflow-wrap:anywhere}
pre.wb-code .line:before{content:counter(line);position:absolute;left:-34px;width:24px;color:#7b7b7b;text-align:right;user-select:none;font-variant-numeric:tabular-nums}
table{width:100%;margin:12px 0;border-collapse:collapse;background:#131414;font-size:15px}td,th{padding:8px 12px;border:1px solid #3a3b3b;text-align:left;vertical-align:top}th{background:#252526;color:#ffffffe6;font-weight:600}
ul,ol{margin:0 0 12px;padding-left:1.6em}li{margin-bottom:4px}li>p{margin-bottom:4px}hr{height:1px;margin:24px 0;border:0;background:#ffffff1f}img{max-width:100%;height:auto}
`;
