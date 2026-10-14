"""Optional bounded MJS binding producer. Reads source JSON, never checkout oracles.
Unsupported syntax/calls remain unknown. This is not a general JavaScript resolver.
"""
import hashlib
import importlib.metadata
import json
import posixpath
import sys
from tree_sitter import Language, Parser
import tree_sitter_javascript

files = json.load(sys.stdin)
parser = Parser(Language(tree_sitter_javascript.language()))
modules, blocks, edges, unknown, diagnostics, calls = {}, [], [], [], [], []
FUNCTIONS = {'function_declaration', 'function_expression', 'arrow_function', 'generator_function_declaration', 'method_definition'}
GLOBALS = {'Object', 'Array', 'Number', 'Math', 'JSON', 'Map', 'TypeError', 'RangeError', 'structuredClone', 'undefined'}
NATIVE = {'Object.freeze', 'Object.hasOwn', 'Array.isArray', 'Number.isSafeInteger', 'Number.isInteger', 'Number.isFinite',
          'Math.round', 'Math.max', 'Math.min', 'JSON.stringify', 'JSON.parse'}

def text(node, data):
    return data[node.start_byte:node.end_byte].decode('utf8') if node else ''

def walk(node):
    yield node
    for child in node.named_children:
        yield from walk(child)

def pattern(node, data):
    if not node:
        return set()
    if node.type in {'identifier', 'shorthand_property_identifier_pattern'}:
        return {text(node, data)}
    if node.type in {'assignment_pattern', 'object_assignment_pattern', 'pair_pattern'}:
        return pattern(node.child_by_field_name('left') or node.child_by_field_name('value'), data)
    result = set()
    for child in node.named_children:
        result |= pattern(child, data)
    return result

def issue(owner, node, data, reason):
    record = {'blockId': owner, 'line': node.start_point.row + 1, 'expression': text(node, data), 'reason': reason}
    if record not in unknown:
        unknown.append(record)

def add_block(path, name, node, data, kind):
    record = {'id': path + '#' + name, 'path': path, 'name': name, 'kind': kind,
              'startLine': node.start_point.row + 1, 'endLine': node.end_point.row + (1 if node.end_point.column else 0),
              'startByte': node.start_byte, 'endByte': node.end_byte, 'fileHash': hashlib.sha256(data).hexdigest()}
    blocks.append(record)
    return record['id']

for path, source in sorted(files.items()):
    data = source.encode('utf8')
    tree = parser.parse(data)
    root = tree.root_node
    errors = [{'line': n.start_point.row + 1, 'type': n.type} for n in walk(root) if n.type == 'ERROR' or n.is_missing]
    diagnostics.append({'path': path, 'fileHash': hashlib.sha256(data).hexdigest(), 'hasError': root.has_error, 'errors': errors})
    module = {'data': data, 'root': root, 'symbols': {}, 'imports': {}, 'exports': {}, 'owners': []}
    modules[path] = module
    for statement in root.named_children:
        node = statement.child_by_field_name('declaration') if statement.type == 'export_statement' else statement
        if node and node.type == 'function_declaration':
            name = text(node.child_by_field_name('name'), data)
            bid = add_block(path, name, node, data, 'function')
            module['symbols'][name] = bid
            module['owners'].append((bid, node))
            if statement.type == 'export_statement':
                module['exports'][name] = ('local', name, None)
        elif node and node.type == 'lexical_declaration':
            declarations = [n for n in node.named_children if n.type == 'variable_declarator']
            for declaration in declarations:
                binding = declaration.child_by_field_name('name')
                if binding.type != 'identifier':
                    issue('@module:' + path, declaration, data, 'unsupported_top_level_pattern')
                    continue
                name = text(binding, data)
                bid = add_block(path, name, node, data, 'binding')
                module['symbols'][name] = bid
                module['owners'].append((bid, declaration.child_by_field_name('value')))
                if statement.type == 'export_statement':
                    module['exports'][name] = ('local', name, None)
        elif statement.type in {'import_statement', 'export_statement'} and statement.child_by_field_name('source'):
            source_node = statement.child_by_field_name('source')
            specifier = text(source_node, data)[1:-1]
            target = posixpath.normpath(posixpath.join(posixpath.dirname(path), specifier)) if specifier.startswith('.') else None
            specs = [n for n in walk(statement) if n.type in {'import_specifier', 'export_specifier'}]
            names = sorted(text(n.child_by_field_name('alias') or n.child_by_field_name('name'), data) for n in specs)
            bid = add_block(path, '@binding:' + ','.join(names), statement, data, 'module_binding')
            if not specs:
                issue(bid, statement, data, 'unsupported_module_binding')
            for spec in specs:
                name = text(spec.child_by_field_name('name'), data)
                alias = text(spec.child_by_field_name('alias'), data) or name
                table = module['imports'] if statement.type == 'import_statement' else module['exports']
                table[alias] = ('import', name, target, bid)
                if target not in files:
                    issue(bid, statement, data, 'external_or_missing_module')
        elif statement.type == 'comment':
            pass
        else:
            issue('@module:' + path, statement, data, 'unsupported_top_level_syntax')

def exported(path, name, seen=None):
    seen = set() if seen is None else seen
    if (path, name) in seen or path not in modules:
        return None, []
    seen.add((path, name))
    module = modules[path]
    entry = module['exports'].get(name)
    if not entry:
        return None, []
    if entry[0] == 'local':
        return module['symbols'].get(entry[1]), []
    target, chain = exported(entry[2], entry[1], seen)
    return target, [entry[3], *chain]

def resolved(path, name):
    module = modules[path]
    if name in module['symbols']:
        return module['symbols'][name], []
    entry = module['imports'].get(name)
    if entry:
        target, chain = exported(entry[2], entry[1])
        return target, [entry[3], *chain]
    return None, []

def edge(a, b, path, node, relation='reference'):
    if a == b:
        return
    record = {'from': a, 'to': b, 'relation': relation, 'evidence': {'path': path,
              'line': node.start_point.row + 1, 'startByte': node.start_byte, 'endByte': node.end_byte,
              'fileHash': hashlib.sha256(modules[path]['data']).hexdigest()}, 'resolution': 'lexical'}
    if record not in edges:
        edges.append(record)

# Resolve module binding chains too; each import/re-export range is itself protected.
for path, module in modules.items():
    for entry in [*module['imports'].values(), *module['exports'].values()]:
        if entry[0] != 'import':
            continue
        target, chain = exported(entry[2], entry[1])
        if target:
            for dependency in [target, *chain]:
                edge(entry[3], dependency, path, module['root'], 'binding')
        else:
            issue(entry[3], module['root'], module['data'], 'unresolved_module_symbol')

def operator(node):
    return next((child.type for child in node.children if not child.is_named), '')

def rejects_nonstring(node, name, data):
    if node and node.type == 'parenthesized_expression':
        return rejects_nonstring(node.named_children[0], name, data)
    if not node or node.type != 'binary_expression':
        return False
    left, right = node.child_by_field_name('left'), node.child_by_field_name('right')
    if operator(node) == '||':
        return rejects_nonstring(left, name, data)
    return operator(node) == '!==' and left.type == 'unary_expression' and text(left, data) == 'typeof ' + name and text(right, data) in {"'string'", '"string"'}

def guarded_string(callee, name, owner_node, data):
    if not name or '.' in name:
        return False
    # Assignment or nested scope defeats this small proof.
    for n in walk(owner_node):
        if n.type in {'assignment_expression', 'augmented_assignment_expression', 'update_expression'} and text(n.child_by_field_name('left') or n.child_by_field_name('argument'), data) == name:
            return False
    parent, child = callee.parent, callee
    while parent and parent != owner_node:
        if parent.type in FUNCTIONS:
            return False
        if parent.type == 'binary_expression' and operator(parent) == '||' and parent.child_by_field_name('right') == child and rejects_nonstring(parent.child_by_field_name('left'), name, data):
            return True
        child, parent = parent, parent.parent
    body = owner_node.child_by_field_name('body')
    if body:
        for statement in body.named_children:
            if statement.start_byte >= callee.start_byte:
                break
            if statement.type != 'if_statement':
                continue
            consequence = statement.child_by_field_name('consequence')
            throwing = consequence.type == 'throw_statement' or consequence.type == 'statement_block' and len(consequence.named_children) == 1 and consequence.named_children[0].type == 'throw_statement'
            if throwing and statement.end_byte < callee.start_byte and rejects_nonstring(statement.child_by_field_name('condition'), name, data):
                return True
    return False

for path, module in modules.items():
    data = module['data']
    for owner, node in module['owners']:
        local = set()
        maps = set()
        local_functions, shadowed_functions = set(), set()
        # Deliberately over-approximate nested/block shadows: never infer an import
        # when any local declaration with that name could affect its binding.
        for n in walk(node):
            if n.type in FUNCTIONS:
                parameters = pattern(n.child_by_field_name('parameters') or n.child_by_field_name('parameter'), data)
                local |= parameters
                shadowed_functions |= parameters
            if n.type == 'variable_declarator':
                local |= pattern(n.child_by_field_name('name'), data)
                shadowed_functions |= pattern(n.child_by_field_name('name'), data)
                value = n.child_by_field_name('value')
                if value and value.type == 'new_expression' and text(value.child_by_field_name('constructor'), data) == 'Map':
                    maps |= pattern(n.child_by_field_name('name'), data)
            if n.type == 'catch_clause':
                local |= pattern(n.child_by_field_name('parameter'), data)
                shadowed_functions |= pattern(n.child_by_field_name('parameter'), data)
            if n.type == 'for_in_statement':
                local |= pattern(n.child_by_field_name('left'), data)
                shadowed_functions |= pattern(n.child_by_field_name('left'), data)
            if n.type == 'function_declaration' and n != node:
                names = pattern(n.child_by_field_name('name'), data)
                shadowed_functions |= local_functions & names
                local_functions |= names
                local |= names
        # A nested named function is inside its owner's modification range. Its
        # body is still walked for every external dependency and unknown call.
        # Any assignment or competing binding defeats this bounded resolution.
        for n in walk(node):
            if n.type in {'assignment_expression', 'augmented_assignment_expression', 'update_expression'}:
                shadowed_functions |= pattern(n.child_by_field_name('left') or n.child_by_field_name('argument'), data)
        for n in walk(node):
            if n.type in {'assignment_expression', 'augmented_assignment_expression', 'update_expression'}:
                lhs = n.child_by_field_name('left') or n.child_by_field_name('argument')
                base = lhs
                while base and base.type in {'member_expression', 'subscript_expression'}:
                    base = base.child_by_field_name('object')
                name = text(base, data)
                if name not in local and (name in module['symbols'] or name in module['imports'] or name in GLOBALS) or name in maps:
                    issue(owner, n, data, 'mutation_of_shared_binding')
            if n.type in {'class_declaration', 'function_expression', 'generator_function_declaration', 'method_definition', 'with_statement'}:
                issue(owner, n, data, 'unsupported_nested_syntax')
            if n.type in {'call_expression', 'new_expression'}:
                callee = n.child_by_field_name('function') or n.child_by_field_name('constructor')
                label = text(callee, data)
                target = None
                if callee.type == 'identifier' and label not in local:
                    target, _ = resolved(path, label)
                calls.append({'blockId': owner, 'path': path, 'line': n.start_point.row + 1,
                              'callee': label, 'target': target})
                if target:
                    edge(owner, target, path, n, 'call')
                else:
                    builtin = (label in {'TypeError', 'RangeError', 'Map', 'structuredClone'} or label in NATIVE
                               or callee.type == 'identifier' and label in local_functions and label not in shadowed_functions)
                    if callee.type == 'member_expression':
                        receiver = text(callee.child_by_field_name('object'), data)
                        method = text(callee.child_by_field_name('property'), data)
                        builtin |= receiver in maps and method in {'get', 'set'} and 'Map' not in local and 'Map' not in module['symbols'] and 'Map' not in module['imports']
                        builtin |= method == 'trim' and guarded_string(callee, receiver, node, data)
                        receiver_node = callee.child_by_field_name('object')
                        numeric = receiver_node.named_children[0] if receiver_node.type == 'parenthesized_expression' else receiver_node
                        builtin |= method == 'toFixed' and numeric.type == 'binary_expression' and any(c.type in {'/', '*', '-', '**'} for c in numeric.children)  # arithmetic yields a primitive
                    base = label.split('.')[0]
                    if base in local and base in GLOBALS or base in module['symbols'] or base in module['imports']:
                        builtin = False
                    if not builtin:
                        issue(owner, n, data, 'unresolved_call_or_shadow')
            if n.type not in {'identifier', 'shorthand_property_identifier'}:
                continue
            parent = n.parent
            # Exclude declaration names and non-reference syntax.
            if parent.type in {'formal_parameters', 'import_specifier', 'export_specifier'}:
                continue
            if parent.child_by_field_name('name') == n or parent.type in {'assignment_pattern', 'object_assignment_pattern'} and parent.child_by_field_name('left') == n:
                continue
            name = text(n, data)
            if name in local:
                continue
            target, chain = resolved(path, name)
            if target:
                for dependency in [target, *chain]:
                    edge(owner, dependency, path, n)
            elif name not in GLOBALS:
                issue(owner, n, data, 'unresolved_reference')

result = {'schema': 1, 'producer': {'name': 'ingress-bounded-mjs-bindings', 'version': 1,
          'sourceHash': hashlib.sha256(open(__file__, 'rb').read()).hexdigest(),
          'treeSitter': importlib.metadata.version('tree-sitter'),
          'javascriptGrammar': importlib.metadata.version('tree-sitter-javascript')},
          'files': diagnostics, 'blocks': blocks, 'edges': edges, 'unknown': unknown, 'calls': calls,
          'coverage': 'top-level named functions/constants and named relative imports/re-exports; nested callbacks walked; unresolved calls refused; native runtime intrinsics assumed unmodified; string trim requires an AST short-circuit or throwing guard; outer MJS syntax only'}
json.dump(result, sys.stdout, indent=2)
print()
