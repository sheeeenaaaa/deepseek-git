/*
 * DeepSeek 对话分支树 - 纯数据层
 *
 * 不依赖 DOM，可在浏览器 content script 和 Node 测试中复用。
 * DeepSeek 的历史消息本身就是一棵树：每条消息有 message_id / parent_id，
 * 编辑用户消息或重新生成回复会在同一父节点下增加一个兄弟节点。
 */
(function (root) {
  'use strict';

  function pathTo(messageId, byId) {
    const path = [];
    let current = byId.get(messageId);
    let guard = 0;
    while (current && guard < 100000) {
      path.push(current.message_id);
      current = current.parent_id == null ? null : byId.get(current.parent_id);
      guard += 1;
    }
    return path.reverse();
  }

  /** Normalize the `chat_session` + `chat_messages` payload from history_messages. */
  function buildModel(bizData) {
    const session = bizData.chat_session || {};
    const messages = Array.isArray(bizData.chat_messages) ? bizData.chat_messages : [];
    const byId = new Map();
    const children = new Map();

    for (const message of messages) byId.set(message.message_id, message);
    for (const message of messages) {
      const key = message.parent_id == null ? null : message.parent_id;
      if (!children.has(key)) children.set(key, []);
      children.get(key).push(message);
    }

    const roots = children.get(null) || [];
    let currentId = session.current_message_id;
    if (!byId.has(currentId)) {
      currentId = messages.length ? messages[messages.length - 1].message_id : null;
    }
    const currentPath = currentId == null ? [] : pathTo(currentId, byId);

    return {
      session,
      messages,
      byId,
      children,
      roots,
      currentId,
      currentPath,
      currentSet: new Set(currentPath),
      fetchedAt: Date.now(),
    };
  }

  function rawTextOf(message) {
    if (!message) return '';
    const fragments = Array.isArray(message.fragments) ? message.fragments : [];
    const pick = (types) => {
      for (const fragment of fragments) {
        if (!fragment || !types.includes(fragment.type)) continue;
        if (typeof fragment.content === 'string' && fragment.content.trim()) return fragment.content;
      }
      return '';
    };
    if (message.role === 'USER') return pick(['REQUEST']);
    return pick(['RESPONSE', 'TEMPLATE_RESPONSE']);
  }

  function hasFiles(message) {
    return Boolean(
      message &&
        Array.isArray(message.fragments) &&
        message.fragments.some((fragment) => fragment && fragment.type === 'FILE' && Array.isArray(fragment.files) && fragment.files.length)
    );
  }

  function cleanText(text) {
    return String(text || '')
      .replace(/```[\s\S]*?```/g, ' [代码] ')
      .replace(/`([^`]*)`/g, '$1')
      .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/[#>*_~]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function excerpt(message, max = 82) {
    if (!message) return '';
    let text = cleanText(rawTextOf(message));
    if (!text && hasFiles(message)) text = '[文件]';
    if (!text) text = message.status === 'WIP' ? '（生成中…）' : '（无文本）';
    if (text.length <= max) return text;
    return text.slice(0, Math.max(1, max - 1)) + '…';
  }

  function roleLabel(message) {
    return message && message.role === 'USER' ? '你' : 'AI';
  }

  /**
   * Build a compact tree of fork points only.
   *
   * A fork is a message with more than one child of the conversation tree.
   * Linear chains are collapsed; every variant row is a child message and
   * may own the next nested fork.
   */
  function buildForkTree(model) {
    const { roots, children, byId } = model;

    function nextFork(startId) {
      let current = byId.get(startId);
      let guard = 0;
      while (current && guard < 100000) {
        const kids = children.get(current.message_id) || [];
        if (kids.length === 0) return null;
        if (kids.length > 1) return current;
        current = kids[0];
        guard += 1;
      }
      return null;
    }

    function forkNode(parent, depth) {
      const kids = children.get(parent.message_id) || [];
      return {
        type: 'fork',
        parent,
        depth,
        variants: kids.map((child, index) => {
          const next = nextFork(child.message_id);
          return {
            index,
            message: child,
            current: model.currentSet.has(child.message_id),
            subtree: next ? forkNode(next, depth + 1) : null,
          };
        }),
      };
    }

    if (!roots.length) return null;
    if (roots.length > 1) {
      return {
        type: 'root',
        parent: null,
        depth: 0,
        variants: roots.map((child, index) => {
          const next = nextFork(child.message_id);
          return {
            index,
            message: child,
            current: model.currentSet.has(child.message_id),
            subtree: next ? forkNode(next, 1) : null,
          };
        }),
      };
    }

    const next = nextFork(roots[0].message_id);
    return next ? forkNode(next, 0) : null;
  }

  function countTree(tree, counters) {
    const out = counters || { forks: 0, variants: 0, leaves: 0 };
    if (!tree) return out;
    out.forks += 1;
    for (const variant of tree.variants) {
      out.variants += 1;
      if (variant.subtree) countTree(variant.subtree, out);
      else out.leaves += 1;
    }
    return out;
  }

  const api = {
    pathTo,
    buildModel,
    buildForkTree,
    countTree,
    rawTextOf,
    hasFiles,
    cleanText,
    excerpt,
    roleLabel,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.DSBT = api;
})(typeof window !== 'undefined' ? window : globalThis);
