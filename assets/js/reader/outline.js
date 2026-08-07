/* ============================================================
   outline.js — PDF 书签目录树
   ============================================================ */

import { h, icon } from '../util.js';

const IC_CARET = '<path d="M9 6l6 6-6 6"/>';

/**
 * @param {HTMLElement} host   容器
 * @param {object} pdf         PDFDocumentProxy
 * @param {object} linkService PDFLinkService
 * @returns {Promise<boolean>} 是否存在目录
 */
export async function renderOutline(host, pdf, linkService) {
  host.replaceChildren();

  let outline = null;
  try {
    outline = await pdf.getOutline();
  } catch (e) {
    console.warn('[outline]', e);
  }

  if (!outline || !outline.length) {
    host.append(
      h(
        'div.side-empty',
        h('p', '这本教材没有内嵌书签目录'),
        h('p.sub', '可以改用左侧「缩略图」按页翻找')
      )
    );
    return false;
  }

  host.append(buildLevel(outline, pdf, linkService, 0));
  return true;
}

function buildLevel(items, pdf, linkService, depth) {
  const ul = h('ul.ol-list', { style: depth ? { paddingInlineStart: '14px' } : null });

  for (const item of items) {
    const li = h('li.ol-item');
    const hasKids = item.items && item.items.length > 0;

    const row = h('div.ol-row');

    let kidsBox = null;
    if (hasKids) {
      const caret = h(
        'button.ol-caret',
        { type: 'button', 'aria-label': '展开', 'aria-expanded': 'false' },
        icon(IC_CARET, '', 12)
      );
      caret.addEventListener('click', (e) => {
        e.stopPropagation();
        const open = li.classList.toggle('open');
        caret.setAttribute('aria-expanded', String(open));
        if (open && !kidsBox) {
          kidsBox = buildLevel(item.items, pdf, linkService, depth + 1);
          li.append(kidsBox);
        } else if (kidsBox) {
          kidsBox.hidden = !open;
        }
      });
      row.append(caret);
    } else {
      row.append(h('span.ol-caret.placeholder'));
    }

    const link = h(
      'button.ol-link',
      {
        type: 'button',
        title: item.title,
        style: {
          fontWeight: item.bold ? '600' : '',
          fontStyle: item.italic ? 'italic' : '',
        },
      },
      item.title || '(无标题)'
    );
    link.addEventListener('click', () => {
      goTo(item, pdf, linkService);
      for (const el of host(li).querySelectorAll('.ol-link.active')) el.classList.remove('active');
      link.classList.add('active');
    });
    row.append(link);

    li.append(row);
    ul.append(li);
  }
  return ul;
}

/** 找到最近的 .side-panel 作为「同一棵树」的作用域 */
function host(el) {
  return el.closest('.side-panel') || document;
}

async function goTo(item, pdf, linkService) {
  try {
    if (item.url) {
      window.open(item.url, '_blank', 'noopener,noreferrer');
      return;
    }
    if (!item.dest) return;
    if (typeof item.dest === 'string') linkService.goToDestination(item.dest);
    else linkService.goToDestination(item.dest);
  } catch (e) {
    console.warn('[outline] 跳转失败', e);
  }
}
