type PageMeta = {
  hasPrevious?: boolean;
  hasNext?: boolean;
  nextCursor?: string | null;
  total?: number;
};

interface PageController {
  page: number;
  pageSize: number;
  reset(): void;
  render(meta?: PageMeta): void;
}

interface CursorPageController {
  stack: Array<string | null>;
  cursor: string | null;
  nextCursor: string | null;
  hasNext: boolean;
  total: number;
  reset(): void;
  render(meta?: PageMeta): void;
}

function createPaginator(containerId: string, onChange: () => void, pageSize = 50): PageController {
  const container = document.getElementById(containerId);
  return {
    page: 1,
    pageSize,
    reset() { this.page = 1; },
    render(meta: PageMeta = {}) {
      if (!container) return;
      const hasPrevious = Boolean(meta.hasPrevious);
      const hasNext = Boolean(meta.hasNext);
      container.innerHTML = '<span>Page ' + this.page + ' / ' + this.pageSize + ' per page</span><div class="pager-actions"><button data-page-action="prev" ' + (!hasPrevious ? 'disabled' : '') + '>Previous</button><button data-page-action="next" ' + (!hasNext ? 'disabled' : '') + '>Next</button></div>';
      const prev = container.querySelector<HTMLButtonElement>('[data-page-action="prev"]');
      const next = container.querySelector<HTMLButtonElement>('[data-page-action="next"]');
      if (prev) prev.onclick = () => { if (hasPrevious) { this.page -= 1; onChange(); } };
      if (next) next.onclick = () => { if (hasNext) { this.page += 1; onChange(); } };
    },
  };
}

const sessionsPager = createPaginator('sessionsPager', () => loadSessions(false), 50);

function createCursorPager(containerId: string, onChange: () => void): CursorPageController {
  const container = document.getElementById(containerId);
  return {
    stack: [],
    cursor: null,
    nextCursor: null,
    hasNext: false,
    total: 0,
    reset() { this.stack = []; this.cursor = null; this.nextCursor = null; this.hasNext = false; this.total = 0; },
    render(meta: PageMeta = {}) {
      if (!container) return;
      this.nextCursor = meta.nextCursor || null;
      this.hasNext = Boolean(meta.hasNext);
      this.total = Number(meta.total || 0);
      container.innerHTML = '<span>' + esc(this.total ? this.total + ' total' : '') + '</span><div class="pager-actions"><button data-cursor-action="prev" ' + (!this.stack.length ? 'disabled' : '') + '>Previous</button><button data-cursor-action="next" ' + (!this.hasNext ? 'disabled' : '') + '>Next</button></div>';
      const prev = container.querySelector<HTMLButtonElement>('[data-cursor-action="prev"]');
      const next = container.querySelector<HTMLButtonElement>('[data-cursor-action="next"]');
      if (prev) prev.onclick = () => { if (this.stack.length) { this.cursor = this.stack.pop() || null; onChange(); } };
      if (next) next.onclick = () => { if (this.hasNext && this.nextCursor) { this.stack.push(this.cursor); this.cursor = this.nextCursor; onChange(); } };
    },
  };
}

const activityPager = createCursorPager('activityPager', () => loadActivity(false));
const auditPager = createCursorPager('auditPager', () => loadAudit(false));
const logPager = createCursorPager('logPager', () => loadLogs(false));
const artifactPager = createCursorPager('artifactPager', () => loadArtifacts(false));
const jobsPager = createCursorPager('jobsPager', () => loadTasks(false));
