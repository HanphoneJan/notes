const express = require('express');
const fs = require('fs').promises;
const path = require('path');
const { existsSync } = require('fs');
const crypto = require('crypto');

// 配置子路径 - 可自定义，这里设置为 '/notes'
const BASE_PATH = '/notes';

const app = express();
const port = process.env.PORT || 6060;

// 用于保存笔记的目录路径
const SAVE_PATH = '_tmp';

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

// 获取笔记文件路径
const getMetaFilePath = (noteName) => {
    return path.join(SAVE_PATH, `${noteName}.meta`);
};

const getContentFilePath = (noteName) => {
    return path.join(SAVE_PATH, noteName);
};

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
                
                // 如果是验证密码，不处理内容
                if (req.body.action === 'verifyPassword') {
                    return res.json({ success: true });
                }
            } catch (err) {
                console.error('密码验证错误:', err);
                return res.status(500).end();
            }
        }

        // 处理密码设置和内容保存
        if (req.body.password) {
            metaData.hasPassword = true;
            metaData.passwordHash = await hashPassword(req.body.password);
            await fs.writeFile(metaFilePath, JSON.stringify(metaData), 'utf8');
        } else if (req.body.clearPassword === 'true') {
            metaData.hasPassword = false;
            metaData.passwordHash = '';
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
    }

    // 处理原始内容请求（保持不变）
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
    let content = '';
    try {
        if (existsSync(contentFilePath)) {
            content = await fs.readFile(contentFilePath, 'utf8');
        }
    } catch (err) {
        console.error('读取文件错误:', err);
    }

    // 转义HTML特殊字符（保持不变）
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

    // 密码保护页面HTML（保持不变）
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

    // 密码设置区域HTML（保持不变）
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
        </div>
    `;

    // 关键修改：HTML中的所有请求路径都要加上子路径前缀
    const html = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${noteName}</title>
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
// 关键修改：JavaScript中的请求URL需要加上子路径前缀
const basePath = '${BASE_PATH}';
let content = '${escapeHtml(content)}';
let passwordVerified = ${!metaData.hasPassword ? 'true' : 'false'};
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
            document.getElementById('password-protection').style.display = 'none';
            document.getElementById('content').value = content;
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

// 清除密码（修改请求URL）
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

// 自动保存内容（修改请求URL）
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

// 初始化（保持不变）
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
