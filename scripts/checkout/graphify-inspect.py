"""Optional AST diagnostics/span producer for Graphify qualification, never a grant authority."""
import argparse
import hashlib
import json
from pathlib import Path
import importlib.metadata
import tree_sitter
import tree_sitter_javascript

parser = argparse.ArgumentParser()
parser.add_argument('root')
parser.add_argument('graph')
parser.add_argument('output')
args = parser.parse_args()
root = Path(args.root).resolve()
graph = json.loads(Path(args.graph).read_text())
ast_parser = tree_sitter.Parser(tree_sitter.Language(tree_sitter_javascript.language()))
definitions, calls, diagnostics = [], [], []
function_types = {'function_declaration', 'generator_function_declaration', 'function_expression',
                  'generator_function', 'arrow_function', 'method_definition'}

def text(node, source):
    return source[node.start_byte:node.end_byte].decode('utf8') if node else ''

def name_of(node, source):
    name = node.child_by_field_name('name')
    if name:
        return text(name, source)
    if node.type in {'arrow_function', 'function_expression', 'generator_function'}:
        parent = node.parent
        if parent and parent.type == 'variable_declarator':
            return text(parent.child_by_field_name('name'), source)
    return ''

def owner(node, source):
    parent = node.parent
    while parent:
        if parent.type in function_types:
            label = name_of(parent, source)
            if label:
                return label
        parent = parent.parent
    return '<module>'

for path in sorted(root.rglob('*.mjs')):
    source = path.read_bytes()
    relative = path.relative_to(root).as_posix()
    digest = hashlib.sha256(source).hexdigest()
    tree = ast_parser.parse(source)
    errors = []
    def walk(node):
        if node.type == 'ERROR' or node.is_missing:
            errors.append({'line': node.start_point.row + 1, 'column': node.start_point.column,
                           'type': node.type, 'missing': node.is_missing})
        if node.type in function_types | {'class_declaration', 'variable_declarator'}:
            name = name_of(node, source)
            if name:
                span = node.parent if node.type in {'arrow_function', 'function_expression', 'generator_function'} and node.parent.type == 'variable_declarator' else node
                definitions.append({'path': relative, 'name': name, 'kind': node.type,
                    'startLine': span.start_point.row + 1,
                    'endLine': span.end_point.row + (1 if span.end_point.column else 0),
                    'startByte': span.start_byte, 'endByte': span.end_byte, 'fileHash': digest})
        if node.type in {'call_expression', 'new_expression'}:
            callee = node.child_by_field_name('function') or node.child_by_field_name('constructor')
            if callee:
                calls.append({'path': relative, 'line': node.start_point.row + 1,
                    'callee': text(callee, source), 'calleeKind': callee.type, 'owner': owner(node, source)})
        for child in node.children:
            walk(child)
    walk(tree.root_node)
    diagnostics.append({'path': relative, 'fileHash': digest, 'hasError': tree.root_node.has_error,
                        'errors': errors})

nodes = {node['id']: node for node in graph['nodes']}
edges = graph.get('edges', graph.get('links', []))
span_matches, unmapped = [], []
for node in graph['nodes']:
    if not node.get('_callable'):
        continue
    label = node['label'].removesuffix('()').removeprefix('.')
    try:
        line = int(str(node.get('source_location', '')).removeprefix('L'))
    except ValueError:
        line = None
    matches = [d for d in definitions if d['path'] == node.get('source_file')
               and d['startLine'] == line and d['name'] == label]
    # A variable binding and its arrow/function value describe the same physical span.
    matches = list({(d['startByte'], d['endByte']): d for d in matches}.values())
    if len(matches) == 1:
        span_matches.append({'nodeId': node['id'], **matches[0]})
    else:
        unmapped.append({'nodeId': node['id'], 'path': node.get('source_file'), 'label': node['label'],
                        'line': line, 'matches': len(matches)})

for call in calls:
    terminal = call['callee'].split('.')[-1]
    resolutions = []
    for edge in edges:
        if edge.get('relation') not in {'calls', 'method', 'indirect_call'}:
            continue
        if edge.get('source_file') != call['path'] or edge.get('source_location') != f"L{call['line']}":
            continue
        target = nodes.get(edge.get('_tgt', edge.get('target')))
        if target and target['label'].removesuffix('()').removeprefix('.') == terminal:
            resolutions.append({'target': target['id'], 'relation': edge['relation'], 'confidence': edge.get('confidence')})
    call['graphTargets'] = resolutions
    call['status'] = 'name_matched_graph_edge' if resolutions else 'no_name_match_or_alias_or_external_or_builtin'

result = {'schema': 1, 'producer': {'tree-sitter': importlib.metadata.version('tree-sitter'),
          'tree-sitter-javascript': importlib.metadata.version('tree-sitter-javascript')},
          'definitions': definitions, 'spans': span_matches, 'unmappedCallableNodes': unmapped,
          'files': diagnostics, 'callSites': calls,
          'coverage': 'outer JavaScript syntax only; name matching is a lower bound and misses aliases; builtin/external/dynamic references and embedded source strings require separate coverage'}
Path(args.output).write_text(json.dumps(result, indent=2) + '\n')
print(json.dumps({'files': len(diagnostics), 'parseErrors': sum(d['hasError'] for d in diagnostics),
      'callableSpans': len(span_matches), 'unmappedCallables': len(unmapped), 'callSites': len(calls),
      'callSitesWithoutMatchingGraphEdge': sum(not c['graphTargets'] for c in calls)}))
