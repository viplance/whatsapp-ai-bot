// Serialized transactional test database. Rejects reads after writes, as Firestore does.
export class MemoryFirestore {
  records = new Map();
  tail = Promise.resolve();
  doc(path) {
    const db = this;
    return { path, id: path.split('/').at(-1),
      get: async () => db.snapshot(path),
      collection: (name) => db.collection(`${path}/${name}`),
      set: (data, options) => db.runTransaction((tx) => tx.set(db.doc(path), data, options)),
      update: (data) => db.runTransaction((tx) => tx.update(db.doc(path), data)),
      delete: () => db.runTransaction((tx) => tx.delete(db.doc(path))),
    };
  }
  snapshot(path) { return { exists: this.records.has(path), data: () => structuredClone(this.records.get(path)), ref: this.doc(path) }; }
  collection(path, sort, limit = Infinity) {
    return { doc: (id) => this.doc(`${path}/${id}`),
      orderBy: (field, direction) => this.collection(path, [field, direction], limit),
      limit: (count) => this.collection(path, sort, count),
      get: async () => {
        let docs = [...this.records.keys()].filter((p) => p.startsWith(`${path}/`) && p.split('/').length === path.split('/').length + 1).map((p) => this.snapshot(p));
        if (sort) docs.sort((a, b) => String(a.data()[sort[0]]).localeCompare(String(b.data()[sort[0]])) * (sort[1] === 'desc' ? -1 : 1));
        return { docs: docs.slice(0, limit) };
      },
    };
  }
  async getAll(...refs) { return refs.map((ref) => this.snapshot(ref.path)); }
  runTransaction(action) {
    const result = this.tail.then(async () => {
      const next = structuredClone(this.records);
      let writing = false;
      const write = (ref, value, merge) => { writing = true; next.set(ref.path, structuredClone(merge ? { ...next.get(ref.path), ...value } : value)); };
      const value = await action({
        get: async (ref) => { if (writing) throw new Error('Transaction reads must precede writes'); return this.snapshot(ref.path); },
        set: (ref, value, options) => write(ref, value, options?.merge),
        create: (ref, value) => { if (next.has(ref.path)) throw new Error('Already exists'); write(ref, value); },
        update: (ref, value) => { if (!next.has(ref.path)) throw new Error('Missing document'); write(ref, value, true); },
        delete: (ref) => { writing = true; next.delete(ref.path); },
      });
      this.records = next;
      return value;
    });
    this.tail = result.catch(() => {});
    return result;
  }
}
