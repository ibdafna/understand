; C symbols. Captures and properties are described in src/extract/symbols.ts.

(preproc_include path: (_) @key (#set! kind "import") (#set! sig "full")) @item
(preproc_def name: (_) @name (#set! kind "const")) @item
(preproc_function_def name: (_) @name (#set! kind "func")) @item

(function_definition
  declarator: [
    (function_declarator declarator: (identifier) @name)
    (pointer_declarator declarator: (function_declarator declarator: (identifier) @name))
  ]
  body: (_) @body (#set! kind "func")) @item
(declaration
  declarator: [
    (function_declarator declarator: (identifier) @name)
    (pointer_declarator declarator: (function_declarator declarator: (identifier) @name))
  ]
  (#set! kind "func")) @item

(struct_specifier name: (_) @name body: (_) @body (#set! kind "struct")) @item
(union_specifier name: (_) @name body: (_) @body (#set! kind "struct")) @item
(enum_specifier name: (_) @name body: (_) @body (#set! kind "enum")) @item
(type_definition declarator: (_) @name (#set! kind "type")) @item

(declaration
  declarator: [
    (identifier) @name
    (init_declarator declarator: (identifier) @name)
    (init_declarator declarator: (pointer_declarator declarator: (identifier) @name))
    (array_declarator declarator: (identifier) @name)
    (init_declarator declarator: (array_declarator declarator: (identifier) @name))
  ]
  (#set! kind "var")) @item
