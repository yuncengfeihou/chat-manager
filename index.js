import {
    getContext,
    loadExtensionSettings,
    renderExtensionTemplateAsync
} from '../../../extensions.js';
import {
    loadChat,
    getRequestHeaders,
    eventSource,
    event_types
} from '../../../../script.js';

// 常量定义
const PLUGIN_NAME = 'chat-manager';
const MODAL_ID = 'chat-manager-modal';
const PREVIEW_MODAL_ID = 'chat-preview-modal';

// 状态变量
let allChatsCache = []; // 存储当前角色的所有聊天及其内容
let isDataLoaded = false;
let currentSearchTerm = '';
let modalEl = null;
let modalDialogEl = null;

// =================================================================
//                      初始化 & UI 注入
// =================================================================

jQuery(async () => {
    // 1. 注入入口按钮
    const buttonHtml = `
        <div id="chat_manager_wand" class="mes_button interactable" title="聊天记录管理器" tabindex="0">
            <i class="fa-solid fa-folder-tree"></i>
        </div>
    `;
    // 按照要求注入到 data_bank_wand_container
    if ($('#data_bank_wand_container').length) {
        $('#data_bank_wand_container').append(buttonHtml);
    } else {
        // 后备方案
        $('#tscript_div').append(buttonHtml);
    }

    // 2. 绑定按钮点击
    $('#chat_manager_wand').on('click', openManagerModal);

    // 3. 构建DOM结构 (Lazy load handled in open function, but ensuring structure here)
    ensureModalStructure();
});

// =================================================================
//                      UI 结构与基础逻辑
// =================================================================

function ensureModalStructure() {
    if (document.getElementById(MODAL_ID)) return;

    // 主模态框
    const modalHtml = `
        <div id="${MODAL_ID}">
            <div class="manager-dialog">
                <!-- 左侧：聊天列表 -->
                <div class="manager-sidebar">
                    <div class="sidebar-header">历史聊天</div>
                    <div class="sidebar-list">
                        <!-- 动态填充 -->
                    </div>
                </div>

                <!-- 右侧：主区域 -->
                <div class="manager-main">
                    <!-- 顶部栏 -->
                    <div class="manager-header">
                        <img class="avatar-toggle" src="img/ai4.png" title="切换侧边栏">
                        <div class="search-container">
                            <input type="text" class="manager-search-input" placeholder="检索当前角色下的所有消息...">
                            <i class="fa-solid fa-magnifying-glass search-icon"></i>
                        </div>
                        <i class="fa-solid fa-xmark close-modal-x"></i>
                    </div>

                    <!-- 结果区域 -->
                    <div class="results-area">
                        <div class="loading-spinner" style="display:none;">正在加载聊天记录...</div>
                        <div class="results-list"></div>
                    </div>
                </div>
            </div>
        </div>
        
        <!-- 预览子模态框 -->
        <div id="${PREVIEW_MODAL_ID}">
            <div class="preview-dialog">
                <h3>消息预览</h3>
                <div class="preview-content"></div>
                <div style="text-align: right;">
                    <button class="btn preview-close-btn">关闭</button>
                </div>
            </div>
        </div>
    `;

    $('body').append(modalHtml);
    modalEl = document.getElementById(MODAL_ID);
    modalDialogEl = modalEl.querySelector('.manager-dialog');

    // 事件绑定：关闭
    $(modalEl).on('click', (e) => {
        if (e.target === modalEl || $(e.target).hasClass('close-modal-x')) closeManagerModal();
    });
    
    // 事件绑定：侧边栏切换
    $(modalEl).find('.avatar-toggle').on('click', () => {
        $(modalEl).find('.manager-sidebar').toggleClass('closed');
    });

    // 事件绑定：搜索
    let debounceTimer;
    $(modalEl).find('.manager-search-input').on('input', (e) => {
        clearTimeout(debounceTimer);
        currentSearchTerm = e.target.value.toLowerCase();
        debounceTimer = setTimeout(() => renderResults(), 300);
    });

    // 预览框事件
    $(`#${PREVIEW_MODAL_ID}`).on('click', (e) => {
        if (e.target.id === PREVIEW_MODAL_ID || $(e.target).hasClass('preview-close-btn')) {
            $(`#${PREVIEW_MODAL_ID}`).hide();
        }
    });

    // 窗口Resize监听 (用于JS居中)
    window.addEventListener('resize', centerManagerDialog);
}

// JS 居中定位逻辑 (开发原则)
function centerManagerDialog() {
    if (!modalEl || modalEl.style.display === 'none') return;
    
    const dialog = modalEl.querySelector('.manager-dialog');
    if (dialog) {
        const dWidth = dialog.offsetWidth;
        const dHeight = dialog.offsetHeight;
        dialog.style.left = `${Math.max(0, (window.innerWidth - dWidth) / 2)}px`;
        dialog.style.top = `${Math.max(0, (window.innerHeight - dHeight) / 2)}px`;
    }

    const previewModal = document.getElementById(PREVIEW_MODAL_ID);
    if (previewModal && previewModal.style.display !== 'none') {
        const pDialog = previewModal.querySelector('.preview-dialog');
        if (pDialog) {
            const pWidth = pDialog.offsetWidth;
            const pHeight = pDialog.offsetHeight;
            pDialog.style.left = `${Math.max(0, (window.innerWidth - pWidth) / 2)}px`;
            pDialog.style.top = `${Math.max(0, (window.innerHeight - pHeight) / 2)}px`;
        }
    }
}

// =================================================================
//                      数据处理逻辑
// =================================================================

async function openManagerModal() {
    ensureModalStructure();
    
    // 设置头像
    const context = getContext();
    let avatarSrc = 'img/ai4.png';
    if (context.characterId !== undefined && context.characters && context.characters[context.characterId]) {
        const char = context.characters[context.characterId];
        if (char.avatar && char.avatar !== 'multichar_dummy.png') {
            avatarSrc = `characters/${char.avatar}`;
        }
    }
    $(modalEl).find('.avatar-toggle').attr('src', avatarSrc);

    // 显示模态框
    modalEl.style.display = 'block';
    centerManagerDialog();

    // 加载数据 (如果角色变了或者第一次打开)
    // 这里简单处理：每次打开如果没数据就加载。实际可以加缓存判断。
    if (!isDataLoaded) {
        await fetchAllChatsForCharacter();
    } else {
        renderSidebar();
        renderResults();
    }
}

function closeManagerModal() {
    if (modalEl) modalEl.style.display = 'none';
    isDataLoaded = false; // 关闭后重置，确保下次打开数据最新
}

/**
 * 核心：获取当前角色下所有聊天及其完整内容
 * 注意：这可能会消耗一些时间，所以需要Loading状态
 */
async function fetchAllChatsForCharacter() {
    const context = getContext();
    if (!context.characterId && !context.groupId) {
        alert("请先选择一个角色或群组。");
        return;
    }

    // UI Loading
    $(modalEl).find('.loading-spinner').show();
    $(modalEl).find('.results-list').empty();
    allChatsCache = [];

    try {
        let chatList = [];
        // 1. 获取聊天列表
        if (context.groupId) {
             const response = await fetch('/api/chats/search', {
                method: 'POST',
                headers: getRequestHeaders(),
                body: JSON.stringify({ group_id: context.groupId, query: '' })
            });
            if(response.ok) chatList = await response.json();
        } else {
            const char = context.characters[context.characterId];
            const response = await fetch('/api/characters/chats', {
                method: 'POST',
                headers: getRequestHeaders(),
                body: JSON.stringify({ avatar_url: char.avatar })
            });
            if(response.ok) chatList = await response.json();
        }

        // 2. 逐个获取内容 (并行请求以加速，但要注意服务器压力)
        // 为了演示稳健性，这里使用 Promise.all，实际可限制并发
        const fetchPromises = chatList.map(async (chatMeta) => {
            const fileName = chatMeta.file_name.replace('.jsonl', '');
            // 跳过当前正在聊的，直接从 context 取 (最新)
            if (fileName === String(context.chatId).replace('.jsonl', '')) {
                return {
                    file_name: fileName,
                    messages: context.chat
                };
            }

            // 调用API获取完整内容
            try {
                const body = context.groupId 
                    ? { id: context.groupId, chat_id: fileName }
                    : { ch_name: context.characters[context.characterId].name, file_name: fileName, avatar_url: context.characters[context.characterId].avatar };
                
                const url = context.groupId ? '/api/chats/group/get' : '/api/chats/get';
                
                const res = await fetch(url, {
                    method: 'POST',
                    headers: getRequestHeaders(),
                    body: JSON.stringify(body)
                });
                
                if (res.ok) {
                    let data = await res.json();
                    // 数据清洗：有些API返回 [metadata, msg1, msg2...]
                    if (Array.isArray(data) && data.length > 0 && (data[0].chat_metadata || data[0].user_name)) {
                        data = data.slice(1);
                    }
                    return { file_name: fileName, messages: data };
                }
            } catch (e) {
                console.error("Fetch chat error", e);
            }
            return null;
        });

        const results = await Promise.all(fetchPromises);
        allChatsCache = results.filter(c => c !== null);
        isDataLoaded = true;

    } catch (e) {
        console.error("Chat Manager Error:", e);
        $(modalEl).find('.results-list').text("加载失败，请检查控制台。");
    } finally {
        $(modalEl).find('.loading-spinner').hide();
        renderSidebar();
        renderResults();
    }
}

// =================================================================
//                      渲染逻辑
// =================================================================

function renderSidebar() {
    const listEl = $(modalEl).find('.sidebar-list');
    listEl.empty();

    allChatsCache.forEach(chat => {
        const item = $(`<div class="sidebar-item">${chat.file_name}</div>`);
        item.on('click', () => {
            // 点击侧边栏，将搜索框置为该文件名，实现"过滤"
            $(modalEl).find('.manager-search-input').val(chat.file_name).trigger('input');
        });
        listEl.append(item);
    });
}

function renderResults() {
    const container = $(modalEl).find('.results-list');
    container.empty();

    const searchTerm = currentSearchTerm.trim();
    let count = 0;
    const MAX_RESULTS = 50; // 限制显示数量防止卡顿

    for (const chat of allChatsCache) {
        if (count >= MAX_RESULTS) break;

        // 1. 如果搜索词为空，显示最后一条消息作为摘要
        // 2. 如果搜索词不为空，查找匹配的消息
        
        if (!searchTerm) {
            // 显示聊天摘要
            if (chat.messages.length === 0) continue;
            const lastMsg = chat.messages[chat.messages.length - 1];
            renderMessageCard(container, chat.file_name, lastMsg, chat.messages.length - 1, "最新消息");
            count++;
        } else {
            // 匹配文件名
            const fileMatch = chat.file_name.toLowerCase().includes(searchTerm);
            
            // 匹配消息内容
            chat.messages.forEach((msg, index) => {
                if (count >= MAX_RESULTS) return;
                
                const content = (msg.mes || '').toLowerCase();
                // 如果文件名匹配，显示所有；或者内容匹配
                if (fileMatch || content.includes(searchTerm)) {
                    renderMessageCard(container, chat.file_name, msg, index, `包含关键词: ${searchTerm}`);
                    count++;
                }
            });
        }
    }

    if (count === 0) {
        container.html('<div style="text-align:center; color:#666; padding:20px;">没有找到匹配的消息。</div>');
    }
}

function renderMessageCard(container, fileName, msg, index, badgeText) {
    const isUser = msg.is_user;
    const name = msg.name || (isUser ? 'User' : 'Character');
    const content = msg.mes || '';

    const card = $(`
        <div class="message-card">
            <div class="message-meta">
                <span><strong>${fileName}</strong> #${index} (${name})</span>
                <span>${badgeText}</span>
            </div>
            <div class="message-content">${content.replace(/</g, '&lt;')}</div>
            <div class="message-actions">
                <button class="btn btn-preview">预览</button>
                <button class="btn btn-primary btn-jump">跳转</button>
            </div>
        </div>
    `);

    // 预览事件
    card.find('.btn-preview').on('click', () => openPreview(content));
    
    // 跳转事件
    card.find('.btn-jump').on('click', () => handleJump(fileName, index));

    container.append(card);
}

function openPreview(content) {
    const pModal = $(`#${PREVIEW_MODAL_ID}`);
    pModal.find('.preview-content').text(content); // 使用 text 防止 XSS，或者简单渲染
    pModal.show();
    centerManagerDialog(); // 重新居中预览框
}

// =================================================================
//                      跳转逻辑 (Command Implementation)
// =================================================================

async function handleJump(targetFileName, targetMessageIndex) {
    const context = getContext();
    const currentFileName = String(context.chatId).replace('.jsonl', '');

    closeManagerModal(); // 先关闭窗口

    // 1. 如果不在目标聊天中，先切换
    if (currentFileName !== targetFileName) {
        toastr.info(`正在切换到聊天: ${targetFileName}...`);
        try {
            await loadChat(targetFileName);
            
            // 等待加载完成。loadChat 是 async 的，但为了保险，稍微延时
            // 或者监听 CHAT_LOADED 事件，这里简化处理
        } catch (e) {
            toastr.error("切换聊天失败");
            console.error(e);
            return;
        }
    }

    // 2. 执行跳转命令
    // 使用 setTimeout 确保 DOM 渲染完成
    setTimeout(() => {
        const commandString = `/chat-jump ${targetMessageIndex}`;
        context.executeSlashCommandsWithOptions(commandString)
            .then(() => {
                toastr.success("已跳转");
            })
            .catch((error) => {
                console.error("跳转命令失败", error);
                toastr.warning("跳转失败，请手动查找");
            });
    }, 500); // 500ms 缓冲
}
