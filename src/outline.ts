import type { headings } from './markdown';
import { icon } from './icons';

type Heading = ReturnType<typeof headings>[number];
type Branch = { heading: Heading; children: Branch[] };

export function outlineTree(items: Heading[], collapsed: Set<string>, activate: (heading: Heading) => void, searching: boolean) {
  const roots: Branch[] = [];
  const ancestors: Branch[] = [];
  for (const heading of items) {
    while (ancestors.length && ancestors.at(-1)!.heading.level >= heading.level) ancestors.pop();
    const branch: Branch = { heading, children: [] };
    (ancestors.at(-1)?.children ?? roots).push(branch);
    ancestors.push(branch);
  }

  const tree = document.createElement('div');
  tree.className = 'outline-tree'; tree.role = 'tree'; tree.setAttribute('aria-label', '文档大纲');
  // Search reveals matching headings without changing the document's saved folds.
  const folds = searching ? new Set<string>() : collapsed;
  const nodes = () => [...tree.querySelectorAll<HTMLElement>('[role="treeitem"]')];
  const visibleNodes = () => nodes().filter(node => !node.closest('[hidden], [inert]'));
  const focusNode = (node: HTMLElement) => {
    node.focus({ preventScroll: true });
    node.firstElementChild?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  };

  const append = (container: HTMLElement, branches: Branch[], depth: number) => {
    branches.forEach(({ heading, children }, index) => {
      const node = document.createElement('div');
      node.className = 'outline-node'; node.role = 'treeitem'; node.tabIndex = -1;
      node.dataset.outlineKey = heading.slug;
      node.setAttribute('aria-label', heading.text || '空标题');
      node.setAttribute('aria-level', String(depth));
      node.setAttribute('aria-posinset', String(index + 1));
      node.setAttribute('aria-setsize', String(branches.length));
      const row = document.createElement('div');
      row.className = 'sidebar-row outline-row'; row.dataset.level = String(heading.level);
      row.style.setProperty('--outline-depth', String(depth - 1));
      const label = document.createElement('span');
      label.className = 'outline-label'; label.textContent = heading.text || '空标题'; label.title = label.textContent;
      row.onclick = () => {
        for (const item of nodes()) item.tabIndex = item === node ? 0 : -1;
        activate(heading);
      };
      node.append(row); container.append(node);
      if (!children.length) {
        const spacer = document.createElement('span'); spacer.className = 'outline-spacer'; spacer.setAttribute('aria-hidden', 'true');
        row.append(spacer, label);
        return;
      }

      const toggle = document.createElement('button');
      toggle.type = 'button'; toggle.className = 'outline-toggle'; toggle.tabIndex = -1; toggle.innerHTML = icon('chevron-right');
      row.append(toggle, label);
      const group = document.createElement('div'); group.role = 'group'; group.className = 'outline-group';
      node.append(group); append(group, children, depth + 1);
      let animation: Animation | undefined;
      const setExpanded = (expanded: boolean, animate: boolean) => {
        if (!expanded && group.contains(document.activeElement)) focusNode(node);
        const height = group.hidden ? 0 : group.getBoundingClientRect().height;
        animation?.cancel(); animation = undefined;
        node.setAttribute('aria-expanded', String(expanded));
        toggle.setAttribute('aria-label', `${expanded ? '收起' : '展开'} ${label.textContent}`);
        toggle.title = expanded ? '收起下级标题' : '展开下级标题';
        if (expanded) folds.delete(heading.slug); else folds.add(heading.slug);
        group.inert = !expanded;
        group.setAttribute('aria-hidden', String(!expanded));
        if (!animate || matchMedia('(prefers-reduced-motion: reduce)').matches) { group.hidden = !expanded; return; }
        group.hidden = false;
        const motion = group.animate([
          { height: `${height}px`, opacity: expanded ? .5 : 1 },
          { height: `${expanded ? group.scrollHeight : 0}px`, opacity: expanded ? 1 : 0 },
        ], { duration: 150, easing: 'cubic-bezier(.2,.8,.2,1)' });
        animation = motion;
        motion.onfinish = () => {
          if (animation !== motion) return;
          group.hidden = !expanded; animation = undefined;
        };
      };
      setExpanded(!folds.has(heading.slug), false);
      toggle.onmousedown = event => event.preventDefault();
      toggle.onclick = event => {
        event.stopPropagation(); focusNode(node);
        setExpanded(node.getAttribute('aria-expanded') !== 'true', true);
      };
    });
  };
  append(tree, roots, 1);
  if (tree.firstElementChild) (tree.firstElementChild as HTMLElement).tabIndex = 0;
  tree.addEventListener('focusin', event => {
    const focused = (event.target as HTMLElement).closest('[role="treeitem"]');
    for (const node of nodes()) node.tabIndex = node === focused ? 0 : -1;
  });
  tree.onkeydown = event => {
    if (event.isComposing || event.keyCode === 229 || event.ctrlKey || event.metaKey || event.altKey) return;
    if ((event.target as HTMLElement).closest('.outline-toggle')) return;
    const node = (event.target as HTMLElement).closest<HTMLElement>('[role="treeitem"]');
    if (!node || !['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'Enter', ' '].includes(event.key)) return;
    event.preventDefault(); event.stopPropagation();
    const visible = visibleNodes();
    const index = visible.indexOf(node);
    const toggle = node.querySelector<HTMLButtonElement>(':scope > .outline-row > .outline-toggle');
    if (event.key === 'Home') focusNode(visible[0]);
    else if (event.key === 'End') focusNode(visible.at(-1)!);
    else if (event.key === 'ArrowUp') focusNode(visible[Math.max(0, index - 1)]);
    else if (event.key === 'ArrowDown') focusNode(visible[Math.min(visible.length - 1, index + 1)]);
    else if (event.key === 'ArrowRight') {
      if (toggle && node.getAttribute('aria-expanded') === 'false') toggle.click();
      else if (toggle) focusNode(node.querySelector<HTMLElement>(':scope > [role="group"] > [role="treeitem"]')!);
    } else if (event.key === 'ArrowLeft') {
      if (toggle && node.getAttribute('aria-expanded') === 'true') toggle.click();
      else { const parent = node.parentElement?.closest<HTMLElement>('[role="treeitem"]'); if (parent) focusNode(parent); }
    } else if (event.key === ' ' && toggle) toggle.click();
    else (node.firstElementChild as HTMLElement).click();
  };
  return tree;
}
