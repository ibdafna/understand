; Go symbols. Captures and properties are described in src/extract/symbols.ts.

(function_declaration name: (_) @name body: (_)? @body
  (#set! kind "func")) @item

(method_declaration
  receiver: (parameter_list (parameter_declaration type: [
    (type_identifier) @scope
    (pointer_type (type_identifier) @scope)
    (generic_type type: (type_identifier) @scope)
    (pointer_type (generic_type type: (type_identifier) @scope))
  ]))
  name: (_) @name body: (_)? @body
  (#set! kind "method")) @item

; Every import is its own symbol; `import ( … )` is the group they share.
(import_declaration (import_spec name: (_)? @name.prefix path: (_) @key) @item (#set! kind "import")) @group
(import_declaration (import_spec_list (import_spec name: (_)? @name.prefix path: (_) @key) @item) (#set! kind "import")) @group

; A const/var/type block is a group of specs; a block with one spec is that spec.
(const_declaration (const_spec name: (_) @name value: (_)? @value) @item
  (#set! kind "const") (#set! sig.prefix "const") (#set! collapse "single") (#set! ordinal "iota")) @group

(var_declaration (var_spec name: (_) @name) @item
  (#set! kind "var") (#set! sig.prefix "var") (#set! collapse "single")) @group
(var_declaration (var_spec_list (var_spec name: (_) @name) @item)
  (#set! kind "var") (#set! sig.prefix "var") (#set! collapse "single")) @group

(type_declaration [(type_spec name: (_) @name type: (struct_type)) (type_alias name: (_) @name type: (struct_type))] @item
  (#set! kind "struct") (#set! sig.prefix "type") (#set! collapse "single")) @group
(type_declaration [(type_spec name: (_) @name type: (interface_type)) (type_alias name: (_) @name type: (interface_type))] @item
  (#set! kind "interface") (#set! sig.prefix "type") (#set! collapse "single")) @group
(type_declaration [(type_spec name: (_) @name) (type_alias name: (_) @name)] @item
  (#set! kind "type") (#set! sig.prefix "type") (#set! collapse "single")) @group
