"""Read-only census of Iteris artifacts; writes sanitized output to stdout.

python3 docs/audits/roxbase-2026-09-30/collect.py /path/to/roxbaase-iteris
"""
import collections
import datetime
import json
import pathlib
import re
import subprocess
import sys

root = pathlib.Path(sys.argv[1]).resolve()
registry = json.loads((root / '.iteris/custom/registry.json').read_text())['entries']
pr_numbers = {1: 426, 2: 428, 3: 429, 4: 430, 5: 431, 6: 432, 7: 433, 8: 434, 9: 435, 10: 436, 11: 437, 12: 438, 13: 439, 14: 440}
rows = []
for identity, entry in sorted(registry.items(), key=lambda item: item[1]['number']):
    directory = root / '.iteris/runs' / ('custom-' + identity)
    report = json.loads((directory / 'review/result.json').read_text())
    context = json.loads((directory / 'review/context.json').read_text())
    state = json.loads((directory / 'custom.json').read_text())
    head = subprocess.run(['git', 'rev-parse', entry['branch']], cwd=root, check=True, capture_output=True, text=True).stdout.strip()
    recoveries = [json.loads(file.read_text()) for file in (directory / 'review/attempts').glob('*/round-*/recovery.json')]
    start, end = [datetime.datetime.fromisoformat(report[field].replace('Z', '+00:00')) for field in ['startedAt', 'finishedAt']]
    checks = report['checks']
    rows.append({
        'number': entry['number'], 'title': context['ticket']['title'], 'branch': entry['branch'],
        'pr': pr_numbers[entry['number']], 'artifact_directory': str(directory),
        'queue_status': state['status'], 'review_outcome': report['outcome'], 'reason': report['reason'],
        'review_head': report['stamp']['head'], 'local_branch_head': head,
        'final_local_head_reviewed': report['stamp']['head'] == head,
        'changed_files_at_review': len(context['changedFiles']), 'diff_characters': len(context['diff']),
        'rounds': report['rounds'], 'repairs': report['repairs'], 'review_minutes': round((end - start).total_seconds() / 60, 2),
        'review_mode': report['mode'], 'policy_characters': len(context['policy']),
        'gap_count': len(report['gaps']),
        'behavioral_tests_in_final_host_report': any(re.search(r'\bdeno\s+test\b|\bnpm\b.*\b(?:test|test:unit|test:integration)\b', check['command']) for check in checks),
        'failed_checks': [check['command'] for check in checks if check['exitCode'] != 0 or check.get('error')],
        'checks': [{key: check.get(key) for key in ['command', 'exitCode', 'durationMs', 'head']} for check in checks],
        'recovery_with_both_checks_and_blocker': sum(bool(recovery['checks']) and bool(recovery['blockedReason']) for recovery in recoveries),
        'discarded_commands_from_blocked_recovery': [command for recovery in recoveries if recovery['blockedReason'] for command in recovery['checks'] if not any(check['command'] == command for check in checks)],
        'findings': [{key: finding.get(key) for key in ['id', 'priority', 'status', 'title', 'head', 'fixedAt', 'duplicateOf']} for finding in report['findings']],
    })
print(json.dumps({'source': str(root), 'cohort': '2026-09-24/25 custom import; 14 tasks', 'summary': {
    'tasks': len(rows), 'outcomes': dict(collections.Counter(row['review_outcome'] for row in rows)),
    'all_marked_done': all(row['queue_status'] == 'done' for row in rows),
    'stale_final_review_heads': sum(not row['final_local_head_reviewed'] for row in rows),
    'no_behavioral_tests_in_final_host_report': sum(not row['behavioral_tests_in_final_host_report'] for row in rows),
    'mixed_blocker_recoveries': sum(row['recovery_with_both_checks_and_blocker'] for row in rows),
    'discarded_commands': sum(len(row['discarded_commands_from_blocked_recovery']) for row in rows),
    'review_minutes': round(sum(row['review_minutes'] for row in rows), 2),
    'rounds': sum(row['rounds'] for row in rows), 'repairs': sum(row['repairs'] for row in rows),
}, 'tasks': rows}, indent=2))
