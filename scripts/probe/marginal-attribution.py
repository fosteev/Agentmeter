import json,glob,os,collections
# Проверка маржинальной модели: cache_creation(N+1) ?= output(N) + tool_result(N) + user text
f=sorted(glob.glob(os.path.expanduser('~/.claude/projects/-Users-fost-Projects-ollama-bar/*.jsonl')),key=os.path.getsize)[-1]
print("файл:",os.path.basename(f), os.path.getsize(f)//1024,"KB")
recs=[json.loads(l) for l in open(f,errors='replace') if l.strip()]

# сшиваем: requestId -> (usage, tool_use блоки), затем tool_result по tool_use_id
by_req=collections.OrderedDict()
tu_owner={}   # tool_use_id -> requestId
for r in recs:
    if r.get('type')!='assistant': continue
    rid=r.get('requestId')
    e=by_req.setdefault(rid,{'usage':None,'tools':[],'ts':r['timestamp']})
    e['usage']=r['message']['usage']
    for c in r['message'].get('content',[]):
        if c.get('type')=='tool_use':
            e['tools'].append(c['name']); tu_owner[c['id']]=rid
res_bytes=collections.defaultdict(int); res_tools=collections.defaultdict(list)
for r in recs:
    if r.get('type')!='user': continue
    c0=r.get('message',{}).get('content')
    if not isinstance(c0,list): continue
    for c in c0:
        if c.get('type')=='tool_result':
            rid=tu_owner.get(c.get('tool_use_id'))
            if rid:
                res_bytes[rid]+=len(json.dumps(c.get('content'),ensure_ascii=False))
                res_tools[rid].append(c.get('tool_use_id'))

reqs=list(by_req.items())
print(f"\n{'#':>3} {'cacheW(N+1)':>11} {'out(N)':>7} {'дельта':>8} {'result KB':>9} {'≈tok(KB/3.6)':>12}  тулы(N)")
rows=[]
for i in range(len(reqs)-1):
    rid,e=reqs[i]; nrid,ne=reqs[i+1]
    cw=ne['usage'].get('cache_creation_input_tokens',0)
    out=e['usage'].get('output_tokens',0)
    delta=cw-out
    kb=res_bytes[rid]/1024
    est=res_bytes[rid]/3.6
    rows.append((delta,est,e['tools']))
    if 8<=i<24:
        print(f"{i:>3} {cw:>11} {out:>7} {delta:>8} {kb:>9.1f} {est:>12.0f}  {','.join(e['tools'])[:40]}")

good=[(d,e) for d,e,t in rows if len(t)==1 and e>200 and d>0]
if good:
    import statistics
    ratio=[d/e for d,e in good]
    print(f"\nодиночные тул-коллы: n={len(good)}  медиана delta/оценка={statistics.median(ratio):.2f}  "
          f"p25={statistics.quantiles(ratio,n=4)[0]:.2f} p75={statistics.quantiles(ratio,n=4)[2]:.2f}")
byt=collections.defaultdict(lambda:[0,0])
for d,e,t in rows:
    if len(t)==1 and d>0:
        byt[t[0]][0]+=d; byt[t[0]][1]+=1
print("\nмаржинальная стоимость по тулам (сумма дельт, вызовов):")
for k,(s,n) in sorted(byt.items(),key=lambda x:-x[1][0]): print(f"  {k:14} {s:>9} tok  {n:>4} вызовов  ~{s//max(n,1):>6} tok/вызов")
