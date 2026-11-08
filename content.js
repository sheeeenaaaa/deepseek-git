/*
 * DeepSeek 对话分支树 - content script
 *
 * 在 chat.deepseek.com 的对话页注入一个「分支」按钮，读取当前对话的
 * history_messages 树，把分支点画成 Git 风格的树；点击分支节点时
 * 调用页面自身的分支切换逻辑（React fiber 上的 onIndexChange）。
 */
(function () {
  'use strict';

  if (window.top !== window) return;
  if (location.hostname !== 'chat.deepseek.com') return;

  const CORE = window.DSBT;
  if (!CORE) {
    console.error('[DeepSeek 分支树] core.js 未加载');
    return;
  }

  const FAB_ID = 'dsbt-fab';
  const PANEL_ID = 'dsbt-panel';
  const TOAST_ID = 'dsbt-toast';
  const BRANCH_TEXT = /^\s*(\d+)\s*\/\s*(\d+)\s*$/;

  const app = {
    sessionId: null,
    model: null,
    tree: null,
    panel: null,
    loading: false,
    navigating: false,
    lastError: '',
    toastTimer: 0,
    zoom: 0.9,
    expanded: new Set(),
  };

  // ------------------------------------------------------------------ utils

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function getSessionId() {
    const match = location.pathname.match(
      /\/chat\/s\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i
    );
    return match ? match[1] : null;
  }

  function getAuthToken() {
    const keys = ['userToken', '__userToken', 'token'];
    for (const key of keys) {
      let raw = null;
      try {
        raw = localStorage.getItem(key);
      } catch {
        raw = null;
      }
      if (!raw) continue;
      try {
        const parsed = JSON.parse(raw);
        if (typeof parsed === 'string' && parsed.trim()) return parsed.trim();
        if (parsed && typeof parsed.value === 'string' && parsed.value.trim()) return parsed.value.trim();
        if (parsed && typeof parsed.token === 'string' && parsed.token.trim()) return parsed.token.trim();
      } catch {
        if (raw.trim()) return raw.trim();
      }
    }
    return null;
  }

  function showToast(message, duration = 2400) {
    let toast = document.getElementById(TOAST_ID);
    if (!toast) {
      toast = el('div', 'dsbt-toast');
      toast.id = TOAST_ID;
      document.body.append(toast);
    }
    toast.textContent = message;
    toast.classList.add('is-visible');
    clearTimeout(app.toastTimer);
    app.toastTimer = setTimeout(() => {
      toast.classList.remove('is-visible');
    }, duration);
  }

  // ------------------------------------------------------------------- data

  async function fetchModel(sessionId, force) {
    if (
      !force &&
      app.model &&
      app.model.session &&
      app.model.session.id === sessionId &&
      Date.now() - app.model.fetchedAt < 15000
    ) {
      return app.model;
    }

    const headers = { Accept: 'application/json' };
    const token = getAuthToken();
    if (token) headers.Authorization = `Bearer ${token}`;

    const response = await fetch(
      `/api/v0/chat/history_messages?chat_session_id=${encodeURIComponent(sessionId)}`,
      { headers, credentials: 'include', cache: 'no-store' }
    );
    if (response.status === 401 || response.status === 403) {
      throw new Error('登录状态已失效，请刷新页面并重新登录');
    }
    if (!response.ok) throw new Error(`读取对话失败（HTTP ${response.status}）`);

    const json = await response.json();
    if (!json || json.code !== 0) throw new Error((json && json.msg) || '读取对话失败');
    const data = json.data;
    if (!data || data.biz_code !== 0 || !data.biz_data) {
      throw new Error((data && data.biz_msg) || '读取对话失败');
    }
    return CORE.buildModel(data.biz_data);
  }

  // -------------------------------------------------------------- DOM helpers

  function messageElement(messageId) {
    return document.querySelector(`[data-virtual-list-item-key="${String(messageId)}"]`);
  }

  function getScroller() {
    const item = document.querySelector('[data-virtual-list-item-key]');
    let node = item;
    while (node && node !== document.body) {
      const style = getComputedStyle(node);
      if (/(auto|scroll)/.test(style.overflowY) && node.scrollHeight > node.clientHeight + 40) {
        return node;
      }
      node = node.parentElement;
    }
    return null;
  }

  function visibleMessageIds() {
    return [...document.querySelectorAll('[data-virtual-list-item-key]')]
      .map((node) => Number(node.getAttribute('data-virtual-list-item-key')))
      .filter((value) => Number.isFinite(value) && value > 0);
  }

  function controlButtons(box) {
    return [...box.children].filter(
      (node) => node.matches && node.matches('button, [role="button"]')
    );
  }

  function isDisabledButton(button) {
    return Boolean(
      button.disabled === true ||
        button.getAttribute('aria-disabled') === 'true' ||
        button.classList.contains('ds-button--disabled')
    );
  }

  function findBranchControl(item) {
    if (!item) return null;
    const textNodes = item.querySelectorAll('div');
    for (const textNode of textNodes) {
      if (textNode.childElementCount !== 0) continue;
      const match = BRANCH_TEXT.exec(textNode.textContent || '');
      if (!match) continue;
      const box = textNode.parentElement;
      if (!box) continue;
      const buttons = controlButtons(box);
      if (buttons.length < 2) continue;
      return {
        box,
        textNode,
        index: Number(match[1]) - 1,
        count: Number(match[2]),
        previous: buttons[0],
        next: buttons[buttons.length - 1],
      };
    }
    return null;
  }

  function reactFiber(node) {
    if (!node) return null;
    for (const key of Object.keys(node)) {
      if (key.startsWith('__reactFiber$')) return node[key];
    }
    return null;
  }

  function getBranchProps(box) {
    let fiber = reactFiber(box);
    let depth = 0;
    while (fiber && depth < 80) {
      const props = fiber.memoizedProps || fiber.pendingProps;
      if (
        props &&
        typeof props.onIndexChange === 'function' &&
        typeof props.index === 'number' &&
        typeof props.count === 'number'
      ) {
        return props;
      }
      fiber = fiber.return;
      depth += 1;
    }
    return null;
  }

  function findControlNear(rect) {
    const candidates = [...document.querySelectorAll('div')];
    let best = null;
    let bestDistance = Infinity;
    for (const node of candidates) {
      if (node.childElementCount !== 0) continue;
      const match = BRANCH_TEXT.exec(node.textContent || '');
      if (!match) continue;
      const box = node.parentElement;
      if (!box) continue;
      const buttons = controlButtons(box);
      if (buttons.length < 2) continue;
      const boxRect = box.getBoundingClientRect();
      const dx = boxRect.left + boxRect.width / 2 - (rect.left + rect.width / 2);
      const dy = boxRect.top + boxRect.height / 2 - (rect.top + rect.height / 2);
      const distance = dx * dx + dy * dy;
      if (distance < bestDistance) {
        bestDistance = distance;
        best = {
          box,
          index: Number(match[1]) - 1,
          count: Number(match[2]),
          previous: buttons[0],
          next: buttons[buttons.length - 1],
        };
      }
    }
    return best;
  }

  async function waitFor(predicate, timeout = 2500, interval = 80) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      try {
        if (predicate()) return true;
      } catch {
        /* ignore */
      }
      await sleep(interval);
    }
    return false;
  }

  /**
   * Bring one message into the rendered virtual-list window.
   * `path` is the target path (root..target) used to estimate its position.
   */
  async function scrollToMessage(messageId, path) {
    let item = messageElement(messageId);
    if (item) {
      item.scrollIntoView({ block: 'center', behavior: 'instant' });
      await sleep(90);
      return true;
    }

    const scroller = getScroller();
    if (!scroller) return false;

    // The message list follows the bottom until it sees a user scroll. A
    // synthetic wheel event marks that intent so a programmatic scroll is not
    // immediately snapped back to the bottom.
    try {
      scroller.dispatchEvent(
        new WheelEvent('wheel', {
          deltaY: -600,
          deltaMode: 0,
          bubbles: true,
          cancelable: true,
          view: window,
        })
      );
    } catch {
      /* WheelEvent unavailable */
    }
    await sleep(140);

    const ids = path && path.length ? path : [];

    // Jump to the top first. This is also what makes the virtual list load
    // the older history pages; then walk downwards until the item renders.
    scroller.scrollTop = 0;
    await sleep(1800);
    item = messageElement(messageId);
    if (item) {
      item.scrollIntoView({ block: 'center', behavior: 'instant' });
      await sleep(80);
      return true;
    }

    const step = Math.max(160, scroller.clientHeight * 0.68);
    for (let attempt = 0; attempt < 110; attempt += 1) {
      scroller.scrollTop = Math.min(
        scroller.scrollHeight,
        scroller.scrollTop + step
      );
      await sleep(70);
      item = messageElement(messageId);
      if (item) {
        item.scrollIntoView({ block: 'center', behavior: 'instant' });
        await sleep(80);
        return true;
      }
      if (scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 2) break;
    }
    return false;
  }

  async function setBranchIndex(currentChildId, targetIndex) {
    let item = messageElement(currentChildId);
    let control = findBranchControl(item);
    if (!control) {
      // The current child may be just outside the rendered window.
      await scrollToMessage(currentChildId);
      item = messageElement(currentChildId);
      control = findBranchControl(item);
    }
    if (!control) return false;
    if (control.index === targetIndex) return true;

    const delta = targetIndex - control.index;
    const props = getBranchProps(control.box);
    if (props && props.index === control.index) {
      props.onIndexChange(delta);
      return true;
    }

    // Fallback for a changed React internals shape: click arrows one step at a time.
    const rect = control.box.getBoundingClientRect();
    let current = control.index;
    const direction = delta > 0 ? 1 : -1;
    for (let step = 0; step < Math.abs(delta); step += 1) {
      const currentControl = findControlNear(rect) || control;
      const button = direction > 0 ? currentControl.next : currentControl.previous;
      if (!button || isDisabledButton(button)) break;
      button.click();
      await sleep(190);
      current += direction;
      if (current === targetIndex) return true;
    }
    return current === targetIndex;
  }

  /**
   * Switch the page to the path that ends at `targetId`.
   * Every fork on the target path is selected in order, from the root down.
   */
  async function navigateToMessage(targetId) {
    const model = app.model;
    if (!model) return false;
    const path = CORE.pathTo(targetId, model.byId);
    if (!path.length) return false;

    for (let index = 0; index < path.length; index += 1) {
      const parentId = index === 0 ? null : path[index - 1];
      const siblings = parentId === null ? model.roots : model.children.get(parentId) || [];
      if (siblings.length <= 1) continue;

      const targetChildId = path[index];
      const targetIndex = siblings.findIndex((message) => message.message_id === targetChildId);
      if (targetIndex < 0) return false;

      const anchorId = parentId === null ? path[0] : parentId;
      await scrollToMessage(anchorId, path);

      let control = null;
      // The current sibling is the one actually rendered in the message slot.
      for (const sibling of siblings) {
        control = findBranchControl(messageElement(sibling.message_id));
        if (control) break;
      }
      if (!control) {
        // If the slot is just outside the rendered window, use the old
        // current path to pick the right sibling, then scroll to it.
        const onOldPath = new Set(model.currentPath);
        for (const sibling of siblings) {
          if (!onOldPath.has(sibling.message_id)) continue;
          await scrollToMessage(sibling.message_id, path);
          control = findBranchControl(messageElement(sibling.message_id));
          if (control) break;
        }
      }
      if (!control) {
        // Last resort: scroll around the fork parent, where the children render.
        await sleep(250);
        for (const sibling of siblings) {
          control = findBranchControl(messageElement(sibling.message_id));
          if (control) break;
        }
      }

      const props = getBranchProps(control.box);
      if (props && props.index !== targetIndex) {
        props.onIndexChange(targetIndex - props.index);
        await waitFor(() => {
          const item = messageElement(targetChildId);
          return Boolean(item && findBranchControl(item));
        }, 2500);
      } else if (!props) {
        const ok = await setBranchIndex(
          siblings.find((sibling) => messageElement(sibling.message_id))?.message_id || targetChildId,
          targetIndex
        );
        if (!ok) return false;
      }

      await sleep(160);
    }

    await scrollToMessage(targetId, path);
    return true;
  }

  // -------------------------------------------------------------------- UI

  const NODE_W = 196;
  const NODE_H = 58;
  const SIDE_W = 104;
  const SIDE_H = 38;
  const ROOT_W = 124;
  const ROOT_H = 40;
  const V_GAP = 134;
  const PAD = 52;

  function iconSvg(className) {
    return `<svg class="${className || ''}" width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M4.75 2.75a1.75 1.75 0 1 0 0 3.5 1.75 1.75 0 0 0 0-3.5Zm0 1.2a.55.55 0 1 1 0 1.1.55.55 0 0 1 0-1.1Z" fill="currentColor"/>
      <path d="M4.75 9.75a1.75 1.75 0 1 0 0 3.5 1.75 1.75 0 0 0 0-3.5Zm0 1.2a.55.55 0 1 1 0 1.1.55.55 0 0 1 0-1.1Z" fill="currentColor"/>
      <path d="M11.25 6.75a1.75 1.75 0 1 0 0 3.5 1.75 1.75 0 0 0 0-3.5Zm0 1.2a.55.55 0 1 1 0 1.1.55.55 0 0 1 0-1.1Z" fill="currentColor"/>
      <path d="M4.75 6.25v3.5M5.4 7.2h3.1c1.1 0 1.9.55 2.2 1.45" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/>
    </svg>`;
  }

  function createFab() {
    if (document.getElementById(FAB_ID)) return;
    const fab = el('button', 'dsbt-fab');
    fab.id = FAB_ID;
    fab.type = 'button';
    fab.title = '对话分支树';
    fab.setAttribute('aria-label', '打开对话分支树');
    fab.innerHTML = `${iconSvg('dsbt-icon')}<span class="dsbt-fab-label">分支</span><span class="dsbt-fab-count" hidden></span>`;
    fab.addEventListener('click', () => {
      if (app.panel) closePanel();
      else openPanel();
    });
    document.body.append(fab);
    updateFab();
  }

  function updateFab() {
    const fab = document.getElementById(FAB_ID);
    if (!fab) return;
    fab.hidden = !(app.sessionId || getSessionId());
  }

  function setFabCount(count) {
    const badge = document.querySelector(`#${FAB_ID} .dsbt-fab-count`);
    if (!badge) return;
    if (count > 0) {
      badge.textContent = String(count);
      badge.hidden = false;
    } else {
      badge.hidden = true;
    }
  }

  function nodeSize(node) {
    if (node.kind === 'root') return { width: ROOT_W, height: ROOT_H };
    if (node.current) return { width: NODE_W, height: NODE_H };
    return { width: SIDE_W, height: SIDE_H };
  }

  function buildPanelShell() {
    const backdrop = el('div', 'dsbt-backdrop');
    backdrop.id = 'dsbt-backdrop';
    backdrop.addEventListener('click', closePanel);

    const panel = el('aside', 'dsbt-panel');
    panel.id = PANEL_ID;
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-modal', 'true');
    panel.setAttribute('aria-label', '对话分支树');

    const head = el('div', 'dsbt-head');
    const titleWrap = el('div', 'dsbt-title-wrap');
    const title = el('div', 'dsbt-title');
    title.innerHTML = `${iconSvg('dsbt-title-icon')}<span>对话分支树</span>`;
    const subtitle = el('div', 'dsbt-subtitle', '正在读取…');
    subtitle.id = 'dsbt-subtitle';
    titleWrap.append(title, subtitle);

    const tools = el('div', 'dsbt-tools');
    const refresh = el('button', 'dsbt-icon-btn');
    refresh.type = 'button';
    refresh.title = '刷新';
    refresh.setAttribute('aria-label', '刷新分支树');
    refresh.innerHTML =
      '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M13 8a5 5 0 1 1-1.46-3.54M13 3.2v3.1H9.9" stroke="currentColor" stroke-width="1.35" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    refresh.addEventListener('click', () => openPanel(true));

    const close = el('button', 'dsbt-icon-btn');
    close.type = 'button';
    close.title = '关闭';
    close.setAttribute('aria-label', '关闭分支树');
    close.innerHTML =
      '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="m4 4 8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>';
    close.addEventListener('click', closePanel);
    tools.append(refresh, close);
    head.append(titleWrap, tools);

    const summary = el('div', 'dsbt-summary');
    summary.id = 'dsbt-summary';

    const toolbar = el('div', 'dsbt-toolbar');
    toolbar.hidden = true;

    const leftGroup = el('div', 'dsbt-tool-group');
    const expandAll = el('button', 'dsbt-tool', '展开全部');
    expandAll.type = 'button';
    expandAll.title = '展开所有侧枝';
    expandAll.addEventListener('click', () => {
      app.expandAll = true;
      app.expanded.clear();
      app.fitPending = false;
      app.zoom = Math.max(app.zoom, 0.8);
      renderTree();
    });
    const collapseSide = el('button', 'dsbt-tool', '收起侧枝');
    collapseSide.type = 'button';
    collapseSide.title = '只展开当前路径';
    collapseSide.addEventListener('click', () => {
      app.expandAll = false;
      app.expanded.clear();
      app.fitPending = false;
      app.zoom = Math.max(app.zoom, 0.8);
      renderTree();
    });
    leftGroup.append(expandAll, collapseSide);

    const rightGroup = el('div', 'dsbt-tool-group');
    const zoomOut = el('button', 'dsbt-tool dsbt-square', '−');
    zoomOut.type = 'button';
    zoomOut.title = '缩小';
    zoomOut.addEventListener('click', () => setZoom(app.zoom - 0.1));
    const zoomLabel = el('span', 'dsbt-zoom-label', '100%');
    const zoomIn = el('button', 'dsbt-tool dsbt-square', '+');
    zoomIn.type = 'button';
    zoomIn.title = '放大';
    zoomIn.addEventListener('click', () => setZoom(app.zoom + 0.1));
    const fit = el('button', 'dsbt-tool', '适应');
    fit.type = 'button';
    fit.title = '缩放到适合窗口';
    fit.addEventListener('click', fitTree);
    rightGroup.append(zoomOut, zoomLabel, zoomIn, fit);

    toolbar.append(leftGroup, rightGroup);

    const body = el('div', 'dsbt-body dsbt-viewport');
    body.id = 'dsbt-body';

    const foot = el('div', 'dsbt-foot');
    foot.innerHTML =
      '<span class="dsbt-legend"><i class="dsbt-dot is-user"></i>你的消息<i class="dsbt-dot is-ai"></i>AI 回复</span><span class="dsbt-foot-hint">悬停节点查看完整内容 · 点击切换</span>';

    const tip = el('div', 'dsbt-tip');
    tip.id = 'dsbt-tip';
    tip.hidden = true;
    tip.addEventListener('mouseenter', () => {
      clearTimeout(app.hideTipTimer);
    });
    tip.addEventListener('mouseleave', scheduleHideTip);

    panel.append(head, summary, toolbar, body, foot);
    document.body.append(tip);
    return { root: panel, backdrop, subtitle, summary, body, toolbar, tip, zoomLabel };
  }

  function renderLoading() {
    if (!app.panel) return;
    app.panel.subtitle.textContent = '正在读取对话历史…';
    app.panel.summary.textContent = '';
    app.panel.toolbar.hidden = true;
    const body = app.panel.body;
    body.classList.add('is-state');
    body.replaceChildren();
    const loading = el('div', 'dsbt-loading');
    loading.append(el('div', 'dsbt-skel'), el('div', 'dsbt-skel'), el('div', 'dsbt-skel'));
    body.append(loading);
  }

  function renderError(message) {
    if (!app.panel) return;
    app.panel.subtitle.textContent = '读取失败';
    app.panel.summary.textContent = '';
    app.panel.toolbar.hidden = true;
    const body = app.panel.body;
    body.classList.add('is-state');
    body.replaceChildren();
    const box = el('div', 'dsbt-error');
    box.append(el('div', 'dsbt-error-text', message));
    const retry = el('button', 'dsbt-inline-btn', '重试');
    retry.type = 'button';
    retry.addEventListener('click', () => openPanel(true));
    box.append(retry);
    body.append(box);
  }

  function renderEmpty(message) {
    if (!app.panel) return;
    app.panel.subtitle.textContent = '';
    app.panel.summary.textContent = '';
    app.panel.toolbar.hidden = true;
    const body = app.panel.body;
    body.classList.add('is-state');
    body.replaceChildren();
    const box = el('div', 'dsbt-empty');
    box.append(el('div', 'dsbt-empty-title', message));
    box.append(
      el(
        'p',
        '',
        '在网页版里编辑一条用户消息，或对一条 AI 回复点「重新生成」，就会形成新的分支。之后回到这里，树会自动出现。'
      )
    );
    body.append(box);
  }

  /**
   * Convert the fork tree into the visible node tree.
   * Every node is one branch variant; its children are the variants of the
   * next fork reachable from it. Side subtrees are collapsed unless expanded.
   */
  function buildVisibleTree(model) {
    const forkTree = app.tree;
    if (!forkTree) return null;

    const root = {
      id: 'root',
      kind: 'root',
      label: '对话开始',
      current: false,
      children: [],
      parent: null,
    };

    function addFork(fork, parentNode) {
      for (const variant of fork.variants || []) {
        const node = {
          id: `v${variant.message.message_id}`,
          kind: 'variant',
          message: variant.message,
          current: model.currentSet.has(variant.message.message_id),
          edgeMessage: fork.parent || null,
          edgeText: fork.parent ? CORE.excerpt(fork.parent, 90) : '',
          children: [],
          hidden: 0,
          parent: parentNode,
        };
        parentNode.children.push(node);

        const showChildren =
          node.current ||
          app.expandAll ||
          app.expanded.has(variant.message.message_id);

        if (variant.subtree && showChildren) {
          addFork(variant.subtree, node);
        } else if (variant.subtree) {
          node.hidden = CORE.countTree(variant.subtree).variants;
        }
      }
    }

    addFork(forkTree, root);
    return root;
  }

  function layoutTree(root) {
    const nodes = [];
    let leafCursor = 0;

    function walk(node, depth) {
      node.depth = depth;
      nodes.push(node);
      if (!node.children.length) {
        const size = nodeSize(node);
        node.x = leafCursor + size.width / 2;
        leafCursor += size.width + 22;
      } else {
        for (const child of node.children) walk(child, depth + 1);
        node.x = (node.children[0].x + node.children[node.children.length - 1].x) / 2;
      }
      node.y = depth * V_GAP;
    }

    walk(root, 0);

    let minX = Infinity;
    for (const node of nodes) minX = Math.min(minX, node.x);
    const shift = PAD - minX;
    let maxRight = 0;
    let maxBottom = 0;
    for (const node of nodes) {
      node.x += shift;
      const size = nodeSize(node);
      maxRight = Math.max(maxRight, node.x + size.width / 2);
      maxBottom = Math.max(maxBottom, node.y + size.height);
    }

    return {
      nodes,
      width: Math.ceil(maxRight + PAD),
      height: Math.ceil(maxBottom + PAD),
    };
  }

  function addEdges(svg, root) {
    const ns = 'http://www.w3.org/2000/svg';
    const nodes = [];
    (function walk(node) {
      nodes.push(node);
      for (const child of node.children) walk(child);
    })(root);

    for (const child of nodes) {
      const parent = child.parent;
      if (!parent) continue;
      const parentHeight = nodeSize(parent).height;
      const px = parent.x;
      const py = parent.y + parentHeight;
      const cx = child.x;
      const cy = child.y;
      const dy = Math.max(24, cy - py);
      const d = `M ${px} ${py} C ${px} ${py + dy * 0.45}, ${cx} ${cy - dy * 0.45}, ${cx} ${cy}`;

      const path = document.createElementNS(ns, 'path');
      path.setAttribute('d', d);
      path.setAttribute('class', `dsbt-edge${child.current ? ' is-current' : ''}`);
      svg.append(path);

      if (child.edgeMessage) {
        const hit = document.createElementNS(ns, 'path');
        hit.setAttribute('d', d);
        hit.setAttribute('class', 'dsbt-edge-hit');
        hit.addEventListener('mouseenter', (event) => showEdgeTip(child, event));
        hit.addEventListener('mousemove', positionTip);
        hit.addEventListener('mouseleave', scheduleHideTip);
        svg.append(hit);
      }
    }
  }

  function createNodeElement(node) {
    const isRoot = node.kind === 'root';
    const size = nodeSize(node);
    const div = el(
      'div',
      `dsbt-node${isRoot ? ' is-root' : ''}${node.current ? ' is-current' : ''}${
        !isRoot && node.message.role === 'USER' ? ' is-user' : ''
      }${!isRoot && node.message.role !== 'USER' ? ' is-ai' : ''}${!isRoot && !node.current ? ' is-side' : ''}`
    );
    div.dataset.nodeId = node.id;
    div.style.left = `${node.x - size.width / 2}px`;
    div.style.top = `${node.y}px`;
    div.style.width = `${size.width}px`;
    div.style.minHeight = `${size.height}px`;

    if (isRoot) {
      div.append(el('span', 'dsbt-root-mark'), el('span', 'dsbt-root-text', '对话开始'));
    } else {
      const top = el('div', 'dsbt-node-top');
      top.append(
        el(
          'span',
          `dsbt-role ${node.message.role === 'USER' ? 'is-user' : 'is-ai'}`,
          CORE.roleLabel(node.message)
        ),
        el('span', 'dsbt-node-id', `#${node.message.message_id}`)
      );
      div.append(top, el('div', 'dsbt-node-text', CORE.excerpt(node.message, 72)));
      if (node.current && !node.children.length) div.append(el('span', 'dsbt-current', '当前'));
      if (node.hidden > 0) {
        const more = el('button', 'dsbt-node-more', `+${node.hidden}`);
        more.type = 'button';
        more.title = `展开后续 ${node.hidden} 个分支`;
        more.setAttribute('aria-label', `展开后续 ${node.hidden} 个分支`);
        more.addEventListener('click', (event) => {
          event.stopPropagation();
          app.expanded.add(node.message.message_id);
          app.fitPending = false;
          renderTree();
        });
        div.append(more);
      }
    }

    div.addEventListener('click', () => {
      if (isRoot) {
        const first = app.model && app.model.roots[0];
        if (first) scrollToMessage(first.message_id, app.model.currentPath);
        return;
      }
      handlePick(node);
    });
    div.addEventListener('mouseenter', (event) => scheduleTip(node, event));
    div.addEventListener('mousemove', positionTip);
    div.addEventListener('mouseleave', scheduleHideTip);

    return div;
  }

  function setZoom(value) {
    app.zoom = Math.min(1.8, Math.max(0.18, Number(value) || 1));
    if (app.panel && app.panel.canvas) {
      app.panel.canvas.style.zoom = String(app.zoom);
    }
    if (app.panel && app.panel.zoomLabel) {
      app.panel.zoomLabel.textContent = `${Math.round(app.zoom * 100)}%`;
    }
  }

  function fitTree() {
    if (!app.panel || !app.panel.canvas) return;
    const body = app.panel.body;
    const canvas = app.panel.canvas;
    canvas.style.zoom = '1';
    const availableW = Math.max(120, body.clientWidth - 40);
    const availableH = Math.max(120, body.clientHeight - 40);
    const zoom = Math.min(1, availableW / canvas.offsetWidth, availableH / canvas.offsetHeight);
    setZoom(zoom);
    scrollCurrentIntoView();
  }

  function scrollCurrentIntoView() {
    if (!app.panel) return;
    const body = app.panel.body;
    const currents = [...body.querySelectorAll('.dsbt-node.is-current')];
    const node = currents[currents.length - 1] || body.querySelector('.dsbt-node');
    if (!node) return;
    const bodyRect = body.getBoundingClientRect();
    const nodeRect = node.getBoundingClientRect();
    body.scrollLeft += nodeRect.left - bodyRect.left - (body.clientWidth - nodeRect.width) / 2;
    body.scrollTop += nodeRect.top - bodyRect.top - (body.clientHeight - nodeRect.height) / 2;
  }

  function renderTree() {
    if (!app.panel || !app.model) return;
    const body = app.panel.body;
    body.classList.remove('is-state');
    body.replaceChildren();
    app.panel.tip.hidden = true;

    const visible = buildVisibleTree(app.model);
    if (!visible) {
      app.panel.toolbar.hidden = true;
      app.panel.summary.textContent = `${app.model.messages.length} 条消息 · 暂无分支`;
      setFabCount(0);
      renderEmpty('当前对话还没有分支');
      return;
    }

    const layout = layoutTree(visible);
    const canvas = el('div', 'dsbt-canvas');
    canvas.style.width = `${layout.width}px`;
    canvas.style.height = `${layout.height}px`;

    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('class', 'dsbt-edges');
    svg.setAttribute('width', String(layout.width));
    svg.setAttribute('height', String(layout.height));
    svg.setAttribute('viewBox', `0 0 ${layout.width} ${layout.height}`);
    canvas.append(svg);
    addEdges(svg, visible);

    for (const node of layout.nodes) canvas.append(createNodeElement(node));

    body.append(canvas);
    app.panel.canvas = canvas;
    app.panel.toolbar.hidden = false;

    const counts = CORE.countTree(app.tree);
    app.panel.subtitle.textContent = (app.model.session && app.model.session.title) || '当前对话';
    app.panel.summary.textContent = `${app.model.messages.length} 条消息 · ${counts.forks} 个分支点 · ${counts.variants} 个分支版本`;
    setFabCount(counts.variants);

    setZoom(app.zoom);
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        if (app.fitPending) {
          app.fitPending = false;
          fitTree();
        } else {
          scrollCurrentIntoView();
        }
      });
    });
  }

  let tipTimer = 0;

  function scheduleTip(node, event) {
    clearTimeout(tipTimer);
    clearTimeout(app.hideTipTimer);
    tipTimer = setTimeout(() => showNodeTip(node, event), 80);
  }

  function scheduleHideTip() {
    clearTimeout(tipTimer);
    clearTimeout(app.hideTipTimer);
    app.hideTipTimer = setTimeout(() => {
      if (app.panel && app.panel.tip) app.panel.tip.hidden = true;
    }, 160);
  }

  function positionTip(event) {
    if (!app.panel || app.panel.tip.hidden) return;
    const tip = app.panel.tip;
    const pad = 12;
    const rect = tip.getBoundingClientRect();
    let x = (event && event.clientX ? event.clientX : 0) + 16;
    let y = (event && event.clientY ? event.clientY : 0) + 16;
    if (x + rect.width > window.innerWidth - pad) x = window.innerWidth - rect.width - pad;
    if (y + rect.height > window.innerHeight - pad) y = window.innerHeight - rect.height - pad;
    tip.style.left = `${Math.max(pad, x)}px`;
    tip.style.top = `${Math.max(pad, y)}px`;
  }

  function tooltipHeader(role, id, current) {
    const head = el('div', 'dsbt-tip-head');
    head.append(
      el(
        'span',
        `dsbt-role ${role === 'USER' ? 'is-user' : 'is-ai'}`,
        role === 'USER' ? '你' : role === 'ROOT' ? '起点' : 'AI'
      )
    );
    if (id != null) head.append(el('span', 'dsbt-tip-id', `#${id}`));
    if (current) head.append(el('span', 'dsbt-tip-current', '当前分支'));
    return head;
  }

  function tooltipBody(text) {
    const body = el('div', 'dsbt-tip-body');
    const value = String(text || '').trim();
    body.textContent = value.length > 12000 ? `${value.slice(0, 12000)}\n…` : value || '（无文本内容）';
    return body;
  }

  function showNodeTip(node, event) {
    if (!app.panel) return;
    const tip = app.panel.tip;
    tip.replaceChildren();
    if (node.kind === 'root') {
      tip.append(tooltipHeader('ROOT'), tooltipBody('这是这棵对话树的起点。点击可以定位到第一条消息。'));
      tip.append(el('div', 'dsbt-tip-foot', '点击定位到第一条消息'));
    } else {
      tip.append(tooltipHeader(node.message.role, node.message.message_id, node.current));
      if (node.edgeMessage) {
        tip.append(el('div', 'dsbt-tip-context', `回复上文：${CORE.excerpt(node.edgeMessage, 140)}`));
      }
      tip.append(tooltipBody(CORE.rawTextOf(node.message)));
      tip.append(
        el(
          'div',
          'dsbt-tip-foot',
          node.current ? '当前所在分支' : '点击切换到此分支'
        )
      );
    }
    tip.hidden = false;
    positionTip(event);
  }

  function showEdgeTip(child, event) {
    if (!app.panel || !child.edgeMessage) return;
    const tip = app.panel.tip;
    tip.replaceChildren();
    tip.append(tooltipHeader(child.edgeMessage.role, child.edgeMessage.message_id, false));
    tip.append(el('div', 'dsbt-tip-context', '这是分支回复的上一条消息'));
    tip.append(tooltipBody(CORE.rawTextOf(child.edgeMessage)));
    tip.append(el('div', 'dsbt-tip-foot', '这条消息之后产生了该分支'));
    tip.hidden = false;
    positionTip(event);
  }

  async function handlePick(node) {
    if (!app.model || !app.panel || app.navigating) return;
    const message = node.message;
    if (!message) return;

    if (node.current) {
      await scrollToMessage(message.message_id, app.model.currentPath);
      showToast('已经在当前分支');
      return;
    }

    app.navigating = true;
    showToast('正在切换分支…', 8000);
    try {
      const ok = await navigateToMessage(message.message_id);
      if (!ok) throw new Error('没有找到可切换的分支控件，请确认页面已加载完成');
      const targetPath = CORE.pathTo(message.message_id, app.model.byId);
      app.model.currentPath = targetPath;
      app.model.currentSet = new Set(targetPath);
      app.model.currentId = targetPath.length ? targetPath[targetPath.length - 1] : null;
      app.tree = CORE.buildForkTree(app.model);
      app.fitPending = false;
      renderTree();
      await scrollToMessage(message.message_id, targetPath);
      showToast('已切换分支');
    } catch (error) {
      showToast((error && error.message) || '切换分支失败', 4200);
    } finally {
      app.navigating = false;
    }
  }

  async function openPanel(force) {
    if (!app.panel) {
      app.panel = buildPanelShell();
      document.body.append(app.panel.backdrop, app.panel.root);
    }
    renderLoading();
    const sessionId = getSessionId();
    app.sessionId = sessionId;

    if (!sessionId) {
      renderEmpty('请先打开一个对话');
      return;
    }

    try {
      const model = await fetchModel(sessionId, Boolean(force));
      app.model = model;
      app.tree = CORE.buildForkTree(model);
      app.fitPending = false;
      if (!force) app.zoom = 0.9;
      renderTree();
    } catch (error) {
      app.lastError = (error && error.message) || '读取对话失败';
      renderError(app.lastError);
    }
  }

  function closePanel() {
    clearTimeout(tipTimer);
    clearTimeout(app.hideTipTimer);
    if (app.panel) {
      app.panel.root.remove();
      app.panel.backdrop.remove();
      if (app.panel.tip) app.panel.tip.remove();
      app.panel = null;
    }
  }


  // --------------------------------------------------------------- lifecycle

  function checkSession() {
    const sessionId = getSessionId();
    if (sessionId === app.sessionId) return;
    app.sessionId = sessionId;
    app.model = null;
    app.tree = null;
    app.expanded.clear();
    app.expandAll = false;
    app.zoom = 0.9;
    app.fitPending = false;
    closePanel();
    updateFab();
    setFabCount(0);
  }

  function init() {
    createFab();
    app.sessionId = getSessionId();
    updateFab();
    setInterval(checkSession, 700);
    window.addEventListener('popstate', checkSession);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
