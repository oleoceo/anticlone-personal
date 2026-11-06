import { randomUUID } from 'node:crypto';

type Entry = { source:string; key?:string; openedAt:Date; recoveredAt?:Date; safeCode?:string };

// Bounded local evidence is best effort, not durable while the database is down.
export class OperationalObservations {
  private entries: Entry[] = [];
  private known = new Set<string>();
  constructor(private report: (line:string)=>void = line=>process.stderr.write(line+'\n')) {}
  observe(source:string, failed:boolean, safeCode?:string) {
    const active=this.entries.find(e=>e.source===source && e.key && !e.recoveredAt);
    if (failed) {
      this.known.add(source);
      if (!active) this.add({source,key:randomUUID(),openedAt:new Date(),safeCode});
    } else if (active) {
      active.recoveredAt=new Date();
    } else if (!this.known.has(source)) {
      this.known.add(source);
      this.add({source,openedAt:new Date()});
    }
  }
  private add(entry:Entry) {
    if (this.entries.length<32) this.entries.push(entry);
    else { this.known.delete(entry.source); this.report('operational diagnostics capacity exceeded'); }
  }
  async reconcile(write:(entry:Readonly<Entry>)=>Promise<void>) {
    for (const pending of this.entries.slice()) {
      // Freeze the exact state passed to persistence; a concurrent recovery must
      // remain queued until that later state has itself been committed.
      const snapshot={...pending};
      await write(snapshot);
      if (!snapshot.key || snapshot.recoveredAt) {
        const index=this.entries.indexOf(pending);
        if (index>=0 && pending.recoveredAt===snapshot.recoveredAt) this.entries.splice(index,1);
      }
    }
  }
}
