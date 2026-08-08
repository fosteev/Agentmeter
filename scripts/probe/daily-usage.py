import json,glob,os,collections,datetime,sys

files=glob.glob(os.path.expanduser('~/.claude/projects/*/*.jsonl'))
today=datetime.date.today()
rows=[]
for f in files:
    if datetime.date.fromtimestamp(os.path.getmtime(f)) < today - datetime.timedelta(days=1): continue
    recs=[]
    for l in open(f,errors='replace'):
        try: recs.append(json.loads(l))
        except: pass
    title=None; sess=os.path.basename(f)[:-6]; proj=os.path.basename(os.path.dirname(f))
    tok=collections.Counter(); models=collections.Counter()
    asst=[r for r in recs if r.get('type')=='assistant']
    for r in recs:
        if r.get('type')=='ai-title': title=r.get('aiTitle')
    seen=set()
    for r in asst:
        rid=r.get('requestId')
        if rid in seen: continue          # одна запись на requestId: контент бьётся на несколько строк
        seen.add(rid)
        u=r['message']['usage']; models[r['message']['model']]+=1
        tok['in']+=u.get('input_tokens',0); tok['out']+=u.get('output_tokens',0)
        tok['cw']+=u.get('cache_creation_input_tokens',0); tok['cr']+=u.get('cache_read_input_tokens',0)
    if not asst: continue
    ts=[r['timestamp'] for r in asst]
    rows.append(dict(proj=proj,sess=sess,title=title,models=dict(models),
                     start=min(ts),end=max(ts),reqs=len(seen),**tok))

rows.sort(key=lambda r:-(r['cw']+r['cr']+r['out']))
print(f"{'проект':38} {'реквестов':>9} {'in':>7} {'out':>8} {'cacheW':>9} {'cacheR':>11}  задача")
for r in rows[:12]:
    print(f"{r['proj'][:38]:38} {r['reqs']:>9} {r['in']:>7} {r['out']:>8} {r['cw']:>9} {r['cr']:>11}  {(r['title'] or '—')[:44]}")
tot=collections.Counter()
for r in rows:
    for k in ('in','out','cw','cr'): tot[k]+=r[k]
print("\nИТОГО за сутки: in=%d out=%d cache_write=%d cache_read=%d  сессий=%d" % (tot['in'],tot['out'],tot['cw'],tot['cr'],len(rows)))
print("«вес лимита» (in+out+cw+cr) =", tot['in']+tot['out']+tot['cw']+tot['cr'])
