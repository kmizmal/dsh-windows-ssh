import { randomUUID } from 'node:crypto';
export class Jobs {
  constructor({maxJobsPerSession=16,maxSessions=128}={}) { this.sessions=new Map(); this.maxJobs=maxJobsPerSession; this.maxSessions=maxSessions; this.closed=false; }
  start(owner, run) {
    if(this.closed) throw Object.assign(new Error('Service disposed'),{code:'DISPOSED'});
    let jobs=this.sessions.get(owner);
    if(!jobs) { if(this.sessions.size>=this.maxSessions) throw Object.assign(new Error('Session job capacity reached'),{code:'JOB_LIMIT'}); this.sessions.set(owner,jobs=new Map()); }
    if(jobs.size>=this.maxJobs) { const settled=[...jobs].find(([,j])=>j.status!=='running'&&j.status!=='cancelling'); if(settled) jobs.delete(settled[0]); else throw Object.assign(new Error('Active job capacity reached'),{code:'JOB_LIMIT'}); }
    const job={id:randomUUID(),status:'running',createdAt:new Date().toISOString(),controller:new AbortController()};
    jobs.set(job.id,job);
    job.promise=Promise.resolve().then(()=>run(job.controller.signal)).then(result=>{job.result=result; job.status=job.controller.signal.aborted?'cancelled':result.ok?'completed':'failed';},error=>{job.result={ok:false,code:error.code??'JOB_ERROR',message:String(error.message??error),remoteStateUnknown:true};job.status=job.controller.signal.aborted?'cancelled':'failed';}).finally(()=>{job.finishedAt=new Date().toISOString();});
    return this.view(job);
  }
  view(job) {const {id,status,createdAt,finishedAt,result}=job;return {ok:true,id,status,createdAt,...(finishedAt?{finishedAt}:{}),...(result?{result}:{}),remoteStateUnknown:status==='cancelling'||status==='cancelled'||result?.remoteStateUnknown===true};}
  query(owner,id,action='get') {const jobs=this.sessions.get(owner);if(action==='list')return {ok:true,jobs:[...(jobs?.values()??[])].map(j=>this.view(j))};const job=jobs?.get(id);if(!job)return {ok:false,code:'JOB_NOT_FOUND',message:'No such job in current session'};if(action==='cancel'&&job.status==='running'){job.status='cancelling';job.controller.abort();}return this.view(job);}
  async dispose() {this.closed=true;const jobs=[...this.sessions.values()].flatMap(m=>[...m.values()]);for(const j of jobs)if(j.status==='running')j.controller.abort();await Promise.all(jobs.map(j=>j.promise));this.sessions.clear();}
}
