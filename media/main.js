(function () {
  const vscode = acquireVsCodeApi();
  const svg = document.getElementById('svg');
  const viewport = document.getElementById('viewport');
  const canvas = document.getElementById('canvas');
  const empty = document.getElementById('empty');
  const hscroll = document.getElementById('hscroll');
  const hthumb = document.getElementById('hthumb');
  const NS = 'http://www.w3.org/2000/svg';

  // 默认尺寸（较之前小两号）；可通过 + / - 按钮缩放
  const NW = 170; // 节点宽
  const NH = 34; // 节点高
  const VGAP = 16; // 同列垂直间距
  const HGAP = 72; // 列间距（连接线长度）
  const MIN_SCALE = 0.4;
  const MAX_SCALE = 3;

  let scale = 1;
  let tx = 0;
  let ty = 0;
  let contentBBox = null;
  let rootPos = null;
  let lastRootKey = null;
  let suppressClick = false;

  function applyTransform() {
    viewport.setAttribute('transform', 'translate(' + tx + ',' + ty + ') scale(' + scale + ')');
  }

  function clampScale(s) {
    return Math.min(MAX_SCALE, Math.max(MIN_SCALE, s));
  }

  function truncate(s, n) {
    if (!s) {
      return '';
    }
    return s.length > n ? s.slice(0, n - 1) + '\u2026' : s;
  }

  function edgePath(x1, y1, x2, y2) {
    const dx = Math.max(50, Math.abs(x2 - x1) * 0.4);
    const c1x = x1 + (x2 > x1 ? dx : -dx);
    const c2x = x2 + (x2 > x1 ? -dx : dx);
    return (
      'M ' + x1 + ' ' + y1 +
      ' C ' + c1x + ' ' + y1 + ' ' + c2x + ' ' + y2 + ' ' + x2 + ' ' + y2
    );
  }

  // 横向可平移范围（由 clamp 计算），供滚动条使用
  let hPanMin = 0;
  let hPanMax = 0;

  // 内容放得下就居中；放不下才允许平移（避免内容在放得下时跑出边界）
  function clamp() {
    if (!contentBBox) {
      return;
    }
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    const s = scale;
    const cw = contentBBox.width * s;
    const ch = contentBBox.height * s;

    if (cw <= w) {
      tx = (w - cw) / 2 - contentBBox.x * s;
      hPanMin = tx;
      hPanMax = tx;
    } else {
      hPanMin = w - (contentBBox.x + contentBBox.width) * s;
      hPanMax = -contentBBox.x * s;
      tx = Math.min(hPanMax, Math.max(hPanMin, tx));
    }

    if (ch <= h) {
      ty = (h - ch) / 2 - contentBBox.y * s;
    } else {
      const minTy = h - (contentBBox.y + contentBBox.height) * s;
      const maxTy = -contentBBox.y * s;
      ty = Math.min(maxTy, Math.max(minTy, ty));
    }

    updateHScroll();
  }

  // 底部水平滚动条：根据当前平移/缩放更新滑块
  let hThumbW = 0;
  let hTravel = 0;
  function updateHScroll() {
    if (!contentBBox) {
      hscroll.classList.remove('visible');
      return;
    }
    // 只要有内容就显示底部滚动条
    hscroll.classList.add('visible');
    const w = canvas.clientWidth;
    const trackW = hscroll.clientWidth;
    const cw = contentBBox.width * scale;
    if (cw <= w + 1 || hPanMax - hPanMin <= 1) {
      // 内容放得下：滑块占满整条，拖动无效
      hThumbW = trackW;
      hTravel = 0;
      hthumb.style.width = trackW + 'px';
      hthumb.style.transform = 'translateX(0px)';
      return;
    }
    hThumbW = Math.max(30, (w / cw) * trackW);
    hTravel = Math.max(0, trackW - hThumbW);
    const range = hPanMax - hPanMin;
    const scrollLeft = hPanMax - tx; // 0 = 内容左端对齐视口
    const fraction = range > 0 ? Math.min(1, Math.max(0, scrollLeft / range)) : 0;
    hthumb.style.width = hThumbW + 'px';
    hthumb.style.transform = 'translateX(' + (fraction * hTravel) + 'px)';
  }

  // 拖动滑块：左右移动图形
  let hDragging = false;
  let hStartX = 0;
  let hStartTx = 0;
  hthumb.addEventListener('mousedown', function (e) {
    hDragging = true;
    hStartX = e.clientX;
    hStartTx = tx;
    e.preventDefault();
    e.stopPropagation();
  });
  window.addEventListener('mousemove', function (e) {
    if (!hDragging || !contentBBox) {
      return;
    }
    const range = hPanMax - hPanMin;
    if (hTravel <= 0 || range <= 0) {
      return;
    }
    const scrollDelta = ((e.clientX - hStartX) / hTravel) * range;
    tx = hStartTx - scrollDelta;
    clamp();
    applyTransform();
  });
  window.addEventListener('mouseup', function () {
    hDragging = false;
  });

  // 点击轨道空白处：快速跳转
  hscroll.addEventListener('mousedown', function (e) {
    if (e.target === hthumb || !contentBBox) {
      return;
    }
    const range = hPanMax - hPanMin;
    if (hTravel <= 0 || range <= 0) {
      return;
    }
    const rect = hscroll.getBoundingClientRect();
    const clickX = e.clientX - rect.left;
    const fraction = Math.min(1, Math.max(0, (clickX - hThumbW / 2) / hTravel));
    tx = hPanMax - fraction * range;
    clamp();
    applyTransform();
  });

  window.addEventListener('resize', function () {
    clamp();
    applyTransform();
  });

  // 将中心函数移到视野中央
  function centerOnRoot() {
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (rootPos) {
      tx = w / 2 - rootPos.x * scale;
      ty = h / 2 - rootPos.y * scale;
    } else if (contentBBox) {
      tx = w / 2 - (contentBBox.x + contentBBox.width / 2) * scale;
      ty = h / 2 - (contentBBox.y + contentBBox.height / 2) * scale;
    }
    clamp();
    applyTransform();
  }

  // 以视野中心为锚点缩放
  function zoomBy(f) {
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    const ns = clampScale(scale * f);
    const cx = (w / 2 - tx) / scale;
    const cy = (h / 2 - ty) / scale;
    scale = ns;
    tx = w / 2 - cx * scale;
    ty = h / 2 - cy * scale;
    clamp();
    applyTransform();
  }

  function layout(data) {
    const byKey = {};
    const columns = {};
    data.nodes.forEach(function (n) {
      byKey[n.key] = n;
      if (!columns[n.column]) {
        columns[n.column] = [];
      }
      columns[n.column].push(n);
    });

    Object.keys(columns).forEach(function (colKey) {
      const col = Number(colKey);
      const list = columns[colKey].slice().sort(function (a, b) {
        return (a.name || '').localeCompare(b.name || '');
      });
      const total = list.length * NH + (list.length - 1) * VGAP;
      list.forEach(function (n, i) {
        n.x = col * (NW + HGAP);
        n.y = -total / 2 + i * (NH + VGAP) + NH / 2;
      });
    });

    return byKey;
  }

  function render(data) {
    while (viewport.firstChild) {
      viewport.removeChild(viewport.firstChild);
    }
    if (!data || !data.nodes || data.nodes.length === 0) {
      empty.style.display = 'flex';
      contentBBox = null;
      rootPos = null;
      updateHScroll();
      return;
    }
    empty.style.display = 'none';

    const byKey = layout(data);

    // 箭头标记
    const defs = document.createElementNS(NS, 'defs');
    ['in', 'out'].forEach(function (k) {
      const marker = document.createElementNS(NS, 'marker');
      marker.setAttribute('id', 'arrow-' + k);
      marker.setAttribute('viewBox', '0 0 10 10');
      marker.setAttribute('refX', '9');
      marker.setAttribute('refY', '5');
      marker.setAttribute('markerWidth', '6');
      marker.setAttribute('markerHeight', '6');
      marker.setAttribute('orient', 'auto-start-reverse');
      const p = document.createElementNS(NS, 'path');
      p.setAttribute('d', 'M 0 0 L 10 5 L 0 10 z');
      p.setAttribute('class', 'arrow-' + k);
      marker.appendChild(p);
      defs.appendChild(marker);
    });
    viewport.appendChild(defs);

    // 连线（箭头由调用者指向被调用者）
    data.edges.forEach(function (e) {
      const a = byKey[e.from];
      const b = byKey[e.to];
      if (!a || !b) {
        return;
      }
      let x1;
      let x2;
      let dir;
      if (b.x >= a.x) {
        x1 = a.x + NW / 2;
        x2 = b.x - NW / 2;
        dir = 'out';
      } else {
        x1 = a.x - NW / 2;
        x2 = b.x + NW / 2;
        dir = 'in';
      }
      const path = document.createElementNS(NS, 'path');
      path.setAttribute('d', edgePath(x1, a.y, x2, b.y));
      path.setAttribute('class', 'edge ' + dir + (e.approx ? ' approx' : ''));
      path.setAttribute('marker-end', 'url(#arrow-' + dir + ')');
      viewport.appendChild(path);
    });

    // 节点
    let rootNode = null;
    data.nodes.forEach(function (n) {
      if (n.isRoot) {
        rootNode = n;
      }
      const g = document.createElementNS(NS, 'g');
      g.setAttribute(
        'class',
        'node' +
          (n.isRoot ? ' center' : '') +
          (n.possible ? ' possible' : '') +
          (n.kind === 'pointer' ? ' pointer' : '')
      );
      g.setAttribute('transform', 'translate(' + n.x + ',' + n.y + ')');
      g.setAttribute('data-id', n.key);

      const rect = document.createElementNS(NS, 'rect');
      rect.setAttribute('x', -NW / 2);
      rect.setAttribute('y', -NH / 2);
      rect.setAttribute('width', NW);
      rect.setAttribute('height', NH);
      rect.setAttribute('rx', 5);
      g.appendChild(rect);

      // 只显示函数名（居中）
      const name = document.createElementNS(NS, 'text');
      name.setAttribute('class', 'name');
      name.setAttribute('text-anchor', 'middle');
      name.setAttribute('y', 0);
      name.textContent = truncate(n.name, 24);
      g.appendChild(name);

      // 近似标记角标
      if (n.badge) {
        const badge = document.createElementNS(NS, 'text');
        badge.setAttribute('class', 'badge ' + (n.badge === '宏' ? 'badge-macro' : 'badge-fnptr'));
        badge.setAttribute('x', NW / 2 - 5);
        badge.setAttribute('y', -NH / 2 + 10);
        badge.setAttribute('text-anchor', 'end');
        badge.textContent = n.badge;
        g.appendChild(badge);
      }

      const title = document.createElementNS(NS, 'title');
      title.textContent =
        n.name + '\n' + n.detail +
        (n.badge ? '\n（' + n.badge + '近似推断）' : '') +
        '\n单击跳转，双击居中，点 + 向外展开';
      g.appendChild(title);

      // 展开/收起按钮：未展开为 +，已展开为 −，加载中为 …
      {
        const btn = document.createElementNS(NS, 'g');
        btn.setAttribute(
          'class',
          'expand' + (n.loading ? ' loading' : '') + (n.expanded ? ' minus' : '')
        );
        btn.setAttribute('data-toggle', n.key);
        btn.setAttribute('transform', 'translate(0,' + (NH / 2 + 10) + ')');

        const circle = document.createElementNS(NS, 'circle');
        circle.setAttribute('r', 8);
        btn.appendChild(circle);

        const t = document.createElementNS(NS, 'text');
        t.setAttribute('text-anchor', 'middle');
        t.setAttribute('dy', '3.5');
        t.textContent = n.loading ? '\u2026' : (n.expanded ? '\u2212' : '+');
        btn.appendChild(t);

        g.appendChild(btn);
      }

      viewport.appendChild(g);
    });

    rootPos = rootNode ? { x: rootNode.x, y: rootNode.y } : null;

    // 包围盒（含展开按钮的下探高度）
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    data.nodes.forEach(function (n) {
      minX = Math.min(minX, n.x - NW / 2);
      maxX = Math.max(maxX, n.x + NW / 2);
      minY = Math.min(minY, n.y - NH / 2);
      maxY = Math.max(maxY, n.y + NH / 2 + 20);
    });
    contentBBox = { x: minX, y: minY, width: maxX - minX, height: maxY - minY };

    // 中心函数变化时（新建/下钻/返回）重新居中；仅展开时保持当前平移与缩放
    if (data.rootKey !== lastRootKey) {
      lastRootKey = data.rootKey;
      centerOnRoot();
    } else {
      clamp();
      applyTransform();
    }
  }

  // 滚轮：上下滚动；Shift+滚轮：左右滚动
  canvas.addEventListener(
    'wheel',
    function (e) {
      e.preventDefault();
      if (e.shiftKey) {
        tx -= e.deltaY;
      } else {
        ty -= e.deltaY;
      }
      clamp();
      applyTransform();
    },
    { passive: false }
  );

  // 拖拽平移
  let dragging = false;
  let lx = 0;
  let ly = 0;
  let moved = 0;
  canvas.addEventListener('mousedown', function (e) {
    if (e.button !== 0) {
      return;
    }
    dragging = true;
    moved = 0;
    lx = e.clientX;
    ly = e.clientY;
    canvas.classList.add('dragging');
  });
  window.addEventListener('mousemove', function (e) {
    if (!dragging) {
      return;
    }
    const dx = e.clientX - lx;
    const dy = e.clientY - ly;
    moved += Math.abs(dx) + Math.abs(dy);
    tx += dx;
    ty += dy;
    lx = e.clientX;
    ly = e.clientY;
    clamp();
    applyTransform();
  });
  window.addEventListener('mouseup', function () {
    if (dragging && moved > 5) {
      suppressClick = true;
    }
    dragging = false;
    canvas.classList.remove('dragging');
  });

  // 单击：展开按钮优先；否则跳转（延迟以区分双击）
  let clickTimer = null;
  svg.addEventListener('click', function (e) {
    if (suppressClick) {
      suppressClick = false;
      return;
    }
    const target = e.target;
    const btn = target.closest ? target.closest('[data-toggle]') : null;
    if (btn) {
      vscode.postMessage({ type: 'toggle', key: btn.getAttribute('data-toggle') });
      return;
    }
    const g = target.closest ? target.closest('[data-id]') : null;
    if (!g) {
      return;
    }
    const key = g.getAttribute('data-id');
    if (clickTimer) {
      return;
    }
    clickTimer = setTimeout(function () {
      clickTimer = null;
      vscode.postMessage({ type: 'open', key: key });
    }, 200);
  });

  // 双击：以该函数为中心
  svg.addEventListener('dblclick', function (e) {
    const target = e.target;
    if (target.closest && target.closest('[data-toggle]')) {
      return;
    }
    const g = target.closest ? target.closest('[data-id]') : null;
    if (!g) {
      return;
    }
    if (clickTimer) {
      clearTimeout(clickTimer);
      clickTimer = null;
    }
    vscode.postMessage({ type: 'recenter', key: g.getAttribute('data-id') });
  });

  document.getElementById('center').addEventListener('click', centerOnRoot);
  document.getElementById('zoomIn').addEventListener('click', function () {
    zoomBy(1.15);
  });
  document.getElementById('zoomOut').addEventListener('click', function () {
    zoomBy(1 / 1.15);
  });
  document.getElementById('back').addEventListener('click', function () {
    vscode.postMessage({ type: 'back' });
  });

  window.addEventListener('message', function (e) {
    const msg = e.data;
    if (msg && msg.type === 'graph') {
      render(msg.data);
    }
  });

  vscode.postMessage({ type: 'ready' });
})();
