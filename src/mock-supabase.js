/* Minimal stand-in for supabase-js v2, good enough to exercise the app's real code paths. */
(function (root) {
  const store = {
    rows: [],          // receipts
    folders: [],
    plans: [],
    projects: [],
    site_records: [],
    site_photos: [],
    missingTables: new Set(),   // name a table here to simulate "not created yet"
    session: null,
    listeners: [],
    files: new Map(),
  };
  root.__mock = store;

  function emit(evt) { store.listeners.forEach(fn => fn(evt, store.session)); }

  function builder(table) {
    const q = { table, _filters: [], _op: null, _payload: null };
    const named = ['folders', 'plans', 'projects', 'site_records', 'site_photos'];
    const bag = () => (named.includes(table) ? store[table] : store.rows);
    const setBag = v => { if (named.includes(table)) store[table] = v; else store.rows = v; };
    q._bag = bag; q._setBag = setBag;

    // .select() after .insert() means "give the row back", not a new query
    q.select = function () { if (!q._op) q._op = 'select'; return q; };
    q.limit = function () { return q; };
    q.is = function (c, v) { q._filters.push(r => (r[c] ?? null) === v); return q; };
    q.insert = function (p) { q._op = 'insert'; q._payload = p; return q; };
    q.delete = function () { q._op = 'delete'; return q; };
    q.update = function (p) { q._op = 'update'; q._payload = p; return q; };
    q.order  = function () { return q; };
    q.gte = function (c, v) { q._filters.push(r => r[c] >= v); return q; };
    q.lte = function (c, v) { q._filters.push(r => r[c] <= v); return q; };
    q.eq  = function (c, v) { q._filters.push(r => (r[c] ?? false) === v); return q; };
    q.in  = function (c, vs) { q._filters.push(r => vs.includes(r[c])); return q; };

    q.then = function (resolve) {
      let result;
      if (store.missingTables.has(q.table)) {
        return Promise.resolve({ data: null, error: {
          code: 'PGRST205',
          message: "Could not find the table 'public." + q.table + "' in the schema cache"
        } }).then(resolve);
      }
      const match = r => q._filters.every(f => f(r));
      if (q._op === 'select') {
        let data = q._bag().filter(match);
        if (q.table === 'plans') {
          data = data.slice().sort((a, b) =>
            String(a.start_date).localeCompare(String(b.start_date)));
        } else if (q.table === 'projects' || q.table.startsWith('site_')) {
          data = data.slice();
        } else if (q.table !== 'folders') {
          data = data.slice().sort((a, b) =>
            String(a.receipt_date).localeCompare(String(b.receipt_date)) ||
            String(a.created_at).localeCompare(String(b.created_at)));
        }
        result = { data, error: null };
      } else if (q._op === 'insert') {
        const base = q.table === 'folders'
          ? { id: 'f-' + Math.random().toString(36).slice(2, 9),
              created_at: new Date().toISOString(), supplier_key: null }
          : q.table === 'plans'
          ? { id: 'p-' + Math.random().toString(36).slice(2, 9),
              created_at: new Date().toISOString(),
              notes: null, created_by_name: null, status: 'not_started', progress: 0 }
          : q.table === 'projects'
          ? { id: 'pj-' + Math.random().toString(36).slice(2, 9),
              created_at: new Date().toISOString(),
              kind: 'project', parent_id: null, archived: false }
          : q.table === 'site_records'
          ? { id: 'sr-' + Math.random().toString(36).slice(2, 9),
              created_at: new Date().toISOString(),
              location: null, notes: null, created_by_name: null }
          : q.table === 'site_photos'
          ? { id: 'sp-' + Math.random().toString(36).slice(2, 9),
              created_at: new Date().toISOString(), sort: 0 }
          : { id: 'id-' + Math.random().toString(36).slice(2, 9),
              created_at: new Date().toISOString(), vendor: null, amount: null,
              vat: null, net: null, vat_rate: null, folder_id: null, currency: 'GBP' };
        const row = Object.assign(base, q._payload);
        q._bag().push(row);
        result = { data: [row], error: null };
      } else if (q._op === 'delete') {
        const going = q._bag().filter(match);
        q._setBag(q._bag().filter(r => !match(r)));
        if (q.table === 'site_records') {            // on delete cascade
          const ids = going.map(r => r.id);
          store.site_photos = store.site_photos.filter(ph => !ids.includes(ph.record_id));
        }
        result = { data: null, error: null };
      } else if (q._op === 'update') {
        const hit = q._bag().filter(match);
        hit.forEach(r => Object.assign(r, q._payload));
        result = { data: hit, error: null };
      } else {
        result = { data: null, error: null };
      }
      return Promise.resolve(result).then(resolve);
    };
    return q;
  }

  root.supabase = {
    createClient() {
      return {
        auth: {
          async getSession() { return { data: { session: store.session } }; },
          onAuthStateChange(fn) {
            store.listeners.push(fn);
            setTimeout(() => fn('INITIAL_SESSION', store.session), 0);
            return { data: { subscription: { unsubscribe() {} } } };
          },
          async signInWithPassword({ email, password }) {
            if (password !== 'correct-horse') {
              return { data: null, error: { message: 'Invalid login credentials' } };
            }
            store.session = { user: { id: 'user-1', email } };
            emit('SIGNED_IN');
            return { data: { session: store.session }, error: null };
          },
          async signUp({ email }) {
            store.session = { user: { id: 'user-1', email } };
            emit('SIGNED_IN');
            return { data: { session: store.session }, error: null };
          },
          async signOut() { store.session = null; emit('SIGNED_OUT'); return { error: null }; },
        },
        from: builder,
        storage: {
          from() {
            return {
              async upload(path, blob, opts) {
                store.files.set(path, { size: blob.size, type: opts?.contentType });
                return { data: { path }, error: null };
              },
              async createSignedUrls(paths) {
                return { data: paths.map(p => ({ path: p, signedUrl: '/pixel.png' })), error: null };
              },
              async createSignedUrl(p) {
                return { data: { signedUrl: '/pixel.png' }, error: null };
              },
              async remove(paths) { paths.forEach(p => store.files.delete(p)); return { error: null }; },
            };
          },
        },
      };
    },
  };
})(window);
