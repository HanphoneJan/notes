const express = require('express');
const fs = require('fs').promises;
const path = require('path');
const { existsSync } = require('fs');
const crypto = require('crypto');

// 配置子路径 - 可自定义，这里设置为 '/notes'
const BASE_PATH = '/notes';

const app = express();
const port = process.env.PORT || 6060;

// 关键修复：设置静态文件目录为当前脚本所在目录
// 并通过子路径访问静态资源
const currentDir = path.dirname(__filename);
app.use(BASE_PATH, express.static(currentDir));

// 用于保存笔记的目录路径
const SAVE_PATH = '_tmp';

// 刷新令牌：验证密码后用于定期拉取内容，5分钟有效
const REFRESH_SECRET = process.env.NOTE_REFRESH_SECRET || 'default-secret';
const REFRESH_TTL_MS = 5 * 60 * 1000;
const createRefreshToken = (noteName) => {
    const expiry = Date.now() + REFRESH_TTL_MS;
    const sig = crypto.createHmac('sha256', REFRESH_SECRET).update(`${noteName}:${expiry}`).digest('hex');
    return Buffer.from(`${noteName}:${expiry}:${sig}`).toString('base64url');
};
const verifyRefreshToken = (token, noteName) => {
    try {
        const decoded = Buffer.from(token, 'base64url').toString();
        const [name, expiry, sig] = decoded.split(':');
        if (name !== noteName || Date.now() > parseInt(expiry, 10)) return false;
        const expected = crypto.createHmac('sha256', REFRESH_SECRET).update(`${noteName}:${expiry}`).digest('hex');
        return sig === expected;
    } catch { return false; }
};

// 确保保存目录存在
if (!existsSync(SAVE_PATH)) {
    fs.mkdir(SAVE_PATH, { recursive: true }).catch(err => 
        console.error('无法创建保存目录:', err)
    );
}

// 中间件
app.use(BASE_PATH, express.urlencoded({ extended: true }));
app.use(BASE_PATH, express.text());
app.use(BASE_PATH, express.json());

// 生成随机笔记名称（5个无歧义字符）
const generateNoteName = () => {
    const chars = '234579abcdefghjkmnpqrstwxyz';
    let result = '';
    for (let i = 0; i < 5; i++) {
        result += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return result;
};

// 验证笔记名称是否有效
const isValidNoteName = (name) => {
    return name && name.length <= 64 && /^[a-zA-Z0-9_-]+$/.test(name);
};

// 密码哈希相关函数
const hashPassword = (password) => {
    return new Promise((resolve, reject) => {
        crypto.randomBytes(16, (err, salt) => {
            if (err) return reject(err);
            salt = salt.toString('hex').substring(0, 20);
            
            crypto.pbkdf2(password, salt, 10000, 512, 'sha512', (err, hash) => {
                if (err) return reject(err);
                resolve(`${salt}$${hash.toString('hex')}`);
            });
        });
    });
};

const verifyPassword = (password, hash) => {
    return new Promise((resolve, reject) => {
        const [salt, key] = hash.split('$');
        crypto.pbkdf2(password, salt, 10000, 512, 'sha512', (err, hash) => {
            if (err) return reject(err);
            resolve(key === hash.toString('hex'));
        });
    });
};

// 按笔记串行化写操作，避免并发写导致数据损坏
const noteWriteChains = new Map();
const withNoteWriteLock = (noteName, fn) => {
    const prev = noteWriteChains.get(noteName) || Promise.resolve();
    const chain = prev.then(() => fn());
    noteWriteChains.set(noteName, chain);
    return chain;
};

// 获取笔记文件路径
const getMetaFilePath = (noteName) => {
    return path.join(SAVE_PATH, `${noteName}.meta`);
};

const getContentFilePath = (noteName) => {
    return path.join(SAVE_PATH, noteName);
};

// 更新笔记访问时间，用于 30 天自动清理判断
const touchNote = (noteName) => {
    const now = Date.now() / 1000;
    const cf = getContentFilePath(noteName);
    const mf = getMetaFilePath(noteName);
    Promise.all([
        existsSync(cf) ? fs.utimes(cf, now, now) : Promise.resolve(),
        existsSync(mf) ? fs.utimes(mf, now, now) : Promise.resolve()
    ]).catch(() => {});
};

// 30 天未访问自动清理（持久化笔记不清理）
const CLEANUP_DAYS = parseInt(process.env.NOTE_CLEANUP_DAYS, 10) || 30;
const runCleanup = async () => {
    try {
        const files = await fs.readdir(SAVE_PATH);
        const noteNames = new Set();
        files.forEach(f => {
            if (f.endsWith('.meta')) noteNames.add(f.slice(0, -5));
            else if (!f.startsWith('.')) noteNames.add(f);
        });
        const cutoff = Date.now() - CLEANUP_DAYS * 24 * 60 * 60 * 1000;
        for (const name of noteNames) {
            let metaData = { persistent: false };
            const mf = getMetaFilePath(name);
            if (existsSync(mf)) {
                try {
                    const m = JSON.parse(await fs.readFile(mf, 'utf8'));
                    if (m.persistent) continue;
                } catch { /* 读取失败则继续检查 mtime */ }
            }
            const cf = getContentFilePath(name);
            const getMtime = async (p) => existsSync(p) ? (await fs.stat(p)).mtimeMs : 0;
            const mtime = Math.max(await getMtime(cf), await getMtime(mf));
            if (mtime > 0 && mtime < cutoff) {
                if (existsSync(cf)) await fs.unlink(cf);
                if (existsSync(mf)) await fs.unlink(mf);
                noteWriteChains.delete(name);
            }
        }
    } catch (err) {
        console.error('清理任务错误:', err);
    }
};
setInterval(runCleanup, 60 * 60 * 1000);

// 根路径重定向到子路径下的新笔记
app.all('/', (req, res) => {
    res.redirect(BASE_PATH);
});

// 子路径根路径重定向到新笔记
app.all(BASE_PATH, async (req, res) => {
    const newNote = generateNoteName();
    return res.redirect(`${BASE_PATH}/${newNote}`);
});

// 处理笔记相关请求 - 增加子路径前缀
app.all(`${BASE_PATH}/:note`, async (req, res) => {
    let noteName = req.params.note;
    if (!isValidNoteName(noteName)) {
        const newNote = generateNoteName();
        return res.redirect(`${BASE_PATH}/${newNote}`);
    }

    const metaFilePath = getMetaFilePath(noteName);
    const contentFilePath = getContentFilePath(noteName);

    // 处理密码设置/验证
    let metaData = { hasPassword: false };
    if (existsSync(metaFilePath)) {
        try {
            const metaContent = await fs.readFile(metaFilePath, 'utf8');
            metaData = JSON.parse(metaContent);
        } catch (err) {
            console.error('读取元数据错误:', err);
        }
    }

    touchNote(noteName);

    // 处理POST请求
    if (req.method === 'POST') {
        // 处理密码验证
        if (metaData.hasPassword && !req.body.passwordVerified) {
            if (!req.body.password) {
                return res.status(401).json({ success: false, reason: '需要密码' });
            }
            
            try {
                const isVerified = await verifyPassword(req.body.password, metaData.passwordHash);
                if (!isVerified) {
                    return res.status(401).json({ success: false, reason: '密码错误' });
                }
                
                // 如果是验证密码，验证成功后返回内容供前端显示
                if (req.body.action === 'verifyPassword') {
                    let noteContent = '';
                    try {
                        if (existsSync(contentFilePath)) {
                            noteContent = await fs.readFile(contentFilePath, 'utf8');
                        }
                    } catch (err) {
                        console.error('读取文件错误:', err);
                    }
                    const refreshToken = createRefreshToken(noteName);
                    return res.json({ success: true, content: noteContent, refreshToken });
                }
            } catch (err) {
                console.error('密码验证错误:', err);
                return res.status(500).end();
            }
        }

        // 所有写操作串行化，避免并发写导致数据损坏
        return withNoteWriteLock(noteName, async () => {
            if (req.body.password) {
                metaData.hasPassword = true;
                metaData.passwordHash = await hashPassword(req.body.password);
                await fs.writeFile(metaFilePath, JSON.stringify(metaData), 'utf8');
            } else if (req.body.clearPassword === 'true') {
                metaData.hasPassword = false;
                metaData.passwordHash = '';
                await fs.writeFile(metaFilePath, JSON.stringify(metaData), 'utf8');
            }
            if (req.body.setPersistent !== undefined) {
                metaData.persistent = req.body.setPersistent === true || req.body.setPersistent === 'true';
                await fs.writeFile(metaFilePath, JSON.stringify(metaData), 'utf8');
            }

            const text = req.body.text;
            try {
                if (text !== undefined) {
                    if (text) {
                        await fs.writeFile(contentFilePath, text, 'utf8');
                    } else {
                        if (existsSync(contentFilePath)) {
                            await fs.unlink(contentFilePath);
                        }
                    }
                }
                return res.json({ success: true });
            } catch (err) {
                console.error('保存文件错误:', err);
                return res.status(500).json({ success: false });
            }
        });
    }

    // 处理 JSON 内容拉取（用于前端定时刷新）
    if (req.method === 'GET' && req.query.format === 'json') {
        if (metaData.hasPassword) {
            const token = req.query.refreshToken;
            if (!token || !verifyRefreshToken(token, noteName)) {
                return res.status(401).json({ error: '需要刷新令牌' });
            }
        }
        try {
            const noteContent = existsSync(contentFilePath)
                ? await fs.readFile(contentFilePath, 'utf8')
                : '';
            return res.json({ content: noteContent });
        } catch (err) {
            console.error('读取文件错误:', err);
            return res.status(500).json({ error: '读取失败' });
        }
    }

    // 处理原始内容请求
    const isRaw = req.query.raw !== undefined;
    const userAgent = req.get('User-Agent') || '';
    const isCurlOrWget = userAgent.startsWith('curl') || userAgent.startsWith('Wget');

    if (isRaw || isCurlOrWget) {
        if (metaData.hasPassword) {
            return res.status(401).send('此笔记受密码保护，请使用网页界面访问');
        }

        try {
            if (existsSync(contentFilePath)) {
                const content = await fs.readFile(contentFilePath, 'utf8');
                res.set('Content-Type', 'text/plain');
                return res.send(content);
            } else {
                return res.status(404).end();
            }
        } catch (err) {
            console.error('读取文件错误:', err);
            return res.status(500).end();
        }
    }

    // 处理HTML页面请求
    // 安全修复：有密码保护时，不读取内容，避免在未验证前泄露
    let content = '';
    if (!metaData.hasPassword) {
        try {
            if (existsSync(contentFilePath)) {
                content = await fs.readFile(contentFilePath, 'utf8');
            }
        } catch (err) {
            console.error('读取文件错误:', err);
        }
    }

    // 转义HTML特殊字符
    const escapeHtml = (str) => {
        return str.replace(/[&<>"']/g, (char) => {
            const entities = {
                '&': '&amp;',
                '<': '&lt;',
                '>': '&gt;',
                '"': '&quot;',
                "'": '&#39;'
            };
            return entities[char] || char;
        });
    };

    // 密码保护页面HTML
    const passwordFormHtml = metaData.hasPassword ? `
        <div id="password-protection" class="password-overlay">
            <div class="password-form">
                <h2>此笔记受密码保护</h2>
                <input type="password" id="password-input" placeholder="请输入密码">
                <button onclick="verifyPassword()">解锁</button>
                <div id="password-error" class="error-message"></div>
            </div>
        </div>
    ` : '';

    // 密码设置区域HTML
    const passwordSettingsHtml = `
        <div class="password-settings">
            <h3>密码保护</h3>
            <div class="setting-row">
                <label>
                    <input type="checkbox" id="enable-password" ${metaData.hasPassword ? 'checked' : ''}>
                    启用密码保护
                </label>
            </div>
            <div id="password-fields" class="${metaData.hasPassword ? '' : 'hidden'}">
                <div class="setting-row">
                    <input type="password" id="new-password" placeholder="设置密码">
                </div>
                <div class="setting-row">
                    <button onclick="savePassword()">保存密码</button>
                    <button onclick="clearPassword()" class="danger">清除密码</button>
                </div>
            </div>
            <div class="setting-row" style="margin-top:15px;padding-top:15px;border-top:1px solid #eee">
                <label style="display:block">
                    <input type="checkbox" id="persistent" ${metaData.persistent ? 'checked' : ''} onchange="savePersistent()">
                    持久化保存
                    <span class="setting-hint">不开启则 30 天自动清理</span>
                </label>
            </div>
        </div>
    `;

    // 关键修改：使用子路径引用favicon
    const html = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Note</title>
<link rel="icon" href="${BASE_PATH}/favicon.ico" sizes="any">
<link rel="icon" href="${BASE_PATH}/favicon.svg" type="image/svg+xml">
<style>
/* CSS样式保持不变 */
body {
    margin: 0;
    background: #ebeef1;
    font-family: sans-serif;
}
.container {
    position: absolute;
    top: 20px;
    right: 20px;
    bottom: 20px;
    left: 20px;
}
#content {
    margin: 0;
    padding: 20px;
    overflow-y: auto;
    resize: none;
    width: 100%;
    height: 100%;
    box-sizing: border-box;
    border: 1px solid #ddd;
    outline: none;
    font-family: monospace;
    font-size: 14px;
    line-height: 1.5;
}
#printable {
    display: none;
}
.settings-btn {
    position: fixed;
    top: 10px;
    right: 10px;
    z-index: 10;
    padding: 5px 10px;
    background: #4CAF50;
    color: white;
    border: none;
    border-radius: 3px;
    cursor: pointer;
}
.settings-panel {
    position: fixed;
    top: 40px;
    right: 10px;
    z-index: 10;
    background: white;
    border: 1px solid #ddd;
    border-radius: 3px;
    padding: 15px;
    box-shadow: 0 2px 10px rgba(0,0,0,0.1);
    display: none;
}
.password-overlay {
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    background: rgba(0,0,0,0.7);
    z-index: 100;
    display: flex;
    align-items: center;
    justify-content: center;
}
.password-form {
    background: white;
    padding: 20px;
    border-radius: 5px;
    width: 300px;
}
.password-form input {
    width: 100%;
    padding: 8px;
    margin: 10px 0;
    box-sizing: border-box;
}
.password-form button {
    width: 100%;
    padding: 8px;
    background: #4CAF50;
    color: white;
    border: none;
    border-radius: 3px;
    cursor: pointer;
}
.error-message {
    color: red;
    margin-top: 10px;
    font-size: 0.9em;
}
.password-settings {
    margin-top: 15px;
    padding-top: 15px;
    border-top: 1px solid #eee;
}
.setting-row {
    margin-bottom: 10px;
}
.setting-hint {
    display: block;
    font-size: 0.85em;
    color: #666;
    margin-top: 4px;
}
.setting-row button {
    margin-right: 5px;
    padding: 5px 10px;
}
.hidden {
    display: none;
}
.danger {
    background: #f44336;
    color: white;
    border: none;
    border-radius: 3px;
    cursor: pointer;
}

@media (prefers-color-scheme: dark) {
    body {
        background: #333b4d;
    }
    #content {
        background: #24262b;
        color: #fff;
        border-color: #495265;
    }
    .settings-panel, .password-form {
        background: #24262b;
        color: #fff;
        border-color: #495265;
    }
    .setting-hint {
        color: #aaa;
    }
}
@media print {
    .container, .settings-btn, .settings-panel, .password-overlay {
        display: none;
    }
    #printable {
        display: block;
        white-space: pre-wrap;
        word-break: break-word;
    }
}
</style>
</head>
<body>
${passwordFormHtml}
<div class="container">
<textarea id="content">${escapeHtml(content)}</textarea>
</div>
<pre id="printable"></pre>
<button class="settings-btn" onclick="toggleSettings()">设置</button>
<div class="settings-panel" id="settings-panel">
    ${passwordSettingsHtml}
</div>

<script>
// JavaScript代码保持不变
const basePath = '${BASE_PATH}';
let content = '${escapeHtml(content)}';
let passwordVerified = ${!metaData.hasPassword ? 'true' : 'false'};
let refreshToken = null;
const noteName = '${noteName}';

// 显示/隐藏设置面板
function toggleSettings() {
    const panel = document.getElementById('settings-panel');
    panel.style.display = panel.style.display === 'block' ? 'none' : 'block';
}

// 密码启用状态切换
document.getElementById('enable-password').addEventListener('change', function() {
    const passwordFields = document.getElementById('password-fields');
    passwordFields.classList.toggle('hidden', !this.checked);
});

// 验证密码
function verifyPassword() {
    const password = document.getElementById('password-input').value;
    const errorDiv = document.getElementById('password-error');
    
    fetch(\`\${basePath}/\${noteName}\`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
            password,
            action: 'verifyPassword'
        })
    })
    .then(response => response.json())
    .then(data => {
        if (data.success) {
            passwordVerified = true;
            content = data.content || '';
            refreshToken = data.refreshToken || null;
            document.getElementById('password-protection').style.display = 'none';
            document.getElementById('content').value = content;
            document.getElementById('printable').textContent = content;
        } else {
            errorDiv.textContent = '密码错误，请重试';
        }
    })
    .catch(err => {
        errorDiv.textContent = '验证失败，请重试';
        console.error('密码验证错误:', err);
    });
}

// 保存密码设置
function savePassword() {
    const newPassword = document.getElementById('new-password').value;
    if (!newPassword) {
        alert('请输入密码');
        return;
    }
    
    fetch(\`\${basePath}/\${noteName}\`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
            password: newPassword,
            passwordVerified: true
        })
    })
    .then(response => response.json())
    .then(data => {
        if (data.success) {
            alert('密码设置成功');
            toggleSettings();
        } else {
            alert('设置失败，请重试');
        }
    });
}

// 保存持久化选项
function savePersistent() {
    const checked = document.getElementById('persistent').checked;
    fetch(\`\${basePath}/\${noteName}\`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
            setPersistent: checked,
            passwordVerified: passwordVerified
        })
    })
    .then(response => response.json())
    .then(data => {
        if (data.success) {
            // 无感，无需提示
        } else {
            document.getElementById('persistent').checked = !checked;
        }
    })
    .catch(() => { document.getElementById('persistent').checked = !checked; });
}

// 清除密码
function clearPassword() {
    if (confirm('确定要移除密码保护吗？')) {
        fetch(\`\${basePath}/\${noteName}\`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ 
                clearPassword: 'true',
                passwordVerified: true
            })
        })
        .then(response => response.json())
        .then(data => {
            if (data.success) {
                alert('密码已清除');
                document.getElementById('enable-password').checked = false;
                document.getElementById('password-fields').classList.add('hidden');
                toggleSettings();
            } else {
                alert('操作失败，请重试');
            }
        });
    }
}

// 定期无感拉取最新内容（仅在没有本地编辑时更新）
function refreshContent() {
    if (!passwordVerified) return;
    const textarea = document.getElementById('content');
    if (content !== textarea.value) return;
    const url = refreshToken
        ? \`\${basePath}/\${noteName}?format=json&refreshToken=\${encodeURIComponent(refreshToken)}\`
        : \`\${basePath}/\${noteName}?format=json\`;
    fetch(url)
        .then(r => r.ok ? r.json() : null)
        .then(data => {
            if (!data || data.content === undefined) return;
            const serverContent = data.content || '';
            if (serverContent === content) return;
            const scrollTop = textarea.scrollTop;
            content = serverContent;
            textarea.value = serverContent;
            document.getElementById('printable').textContent = serverContent;
            textarea.scrollTop = scrollTop;
            textarea.setSelectionRange(serverContent.length, serverContent.length);
        })
        .catch(() => {});
}
setInterval(refreshContent, 5000);

// 自动保存内容
function uploadContent() {
    if (!passwordVerified) {
        setTimeout(uploadContent, 1000);
        return;
    }
    
    const textarea = document.getElementById('content');
    if (content !== textarea.value) {
        const temp = textarea.value;
        fetch(\`\${basePath}/\${noteName}\`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ 
                text: temp,
                passwordVerified: true
            })
        })
        .then(response => response.json())
        .then(data => {
            if (data.success) {
                content = temp;
                document.getElementById('printable').textContent = temp;
            }
            setTimeout(uploadContent, 1000);
        })
        .catch(err => {
            console.error('保存失败:', err);
            setTimeout(uploadContent, 1000);
        });
    } else {
        setTimeout(uploadContent, 1000);
    }
}

// 初始化
document.getElementById('content').value = passwordVerified ? content : '';
document.getElementById('printable').textContent = content;
if (passwordVerified) {
    document.getElementById('content').focus();
}
uploadContent();
</script>
</body>
</html>`;

    res.send(html);
});

// 启动服务器
app.listen(port, () => {
    console.log(`Server running on http://localhost:${port} with base path ${BASE_PATH}`);
});
