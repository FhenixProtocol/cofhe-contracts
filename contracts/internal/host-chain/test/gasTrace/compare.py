import json, sys
T = sys.argv[1].rstrip('/') + '/'
b = json.load(open(T + 'trace_base.json'))
s = json.load(open(T + 'trace_spike.json'))
print(f"gasUsed: base={b['gasUsed']} spike={s['gasUsed']} diff={s['gasUsed'] - b['gasUsed']:+}")
for sec in ['byFrame', 'callOverhead']:
    print('\n' + sec)
    for k in sorted(set(b[sec]) | set(s[sec])):
        x, y = b[sec].get(k, 0), s[sec].get(k, 0)
        print(f"  {k:<62} {x:>7} {y:>7} {y - x:+7}")
print('\nbyOp (|diff|>=30)')
d = {k: s['byOp'].get(k, 0) - b['byOp'].get(k, 0) for k in set(b['byOp']) | set(s['byOp'])}
for k, v in sorted(d.items(), key=lambda kv: -abs(kv[1])):
    if abs(v) >= 30:
        print(f"  {k:<16} {b['byOp'].get(k, 0):>7} {s['byOp'].get(k, 0):>7} {v:+7}")
print('  sum of all op diffs:', sum(d.values()))
