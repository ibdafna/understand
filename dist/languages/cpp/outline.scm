; C++ symbols. Captures and properties are described in src/extract/symbols.ts.
; Specific patterns come first: when two patterns find the same item, the earlier one wins.

(preproc_include path: (_) @key (#set! kind "import") (#set! sig "full")) @item
(using_declaration (_) @key (#set! kind "import") (#set! sig "full") (#set! qualify "no")) @item
(preproc_def name: (_) @name (#set! kind "const")) @item
(preproc_function_def name: (_) @name (#set! kind "func")) @item

(namespace_definition name: (_) @name body: (_) @body (#set! kind "namespace") (#set! container "true")) @item
(class_specifier name: (_) @name body: (_) @body (#set! kind "class") (#set! container "true")) @item
(struct_specifier name: (_) @name body: (_) @body (#set! kind "struct") (#set! container "true")) @item
(union_specifier name: (_) @name body: (_) @body (#set! kind "struct")) @item
(enum_specifier name: (_) @name body: (_) @body (#set! kind "enum")) @item
(type_definition declarator: (_) @name (#set! kind "type")) @item
(alias_declaration name: (_) @name (#set! kind "type")) @item

; Functions defined inside a class body are its methods (also when they return a reference or pointer).
(field_declaration_list (function_definition
  declarator: [
    (function_declarator declarator: [(identifier) (field_identifier) (operator_name) (destructor_name)] @name)
    (reference_declarator (function_declarator declarator: [(identifier) (field_identifier) (operator_name)] @name))
    (pointer_declarator declarator: (function_declarator declarator: [(identifier) (field_identifier) (operator_name)] @name))
  ]
  (field_initializer_list)? @body body: (_) @body) @item (#set! kind "method"))
(field_declaration_list (template_declaration (function_definition
  declarator: (function_declarator declarator: [(identifier) (field_identifier) (operator_name) (destructor_name)] @name)
  (field_initializer_list)? @body body: (_) @body)) @item (#set! kind "method"))

(field_declaration_list (declaration declarator: (function_declarator declarator: (_) @name)) @item (#set! kind "method"))

; A constructor's initializer list isn't part of its signature, so it counts as body.
; A method defined outside its class is named after the class (Store::add → Store.add).
(function_definition
  declarator: [
    (function_declarator declarator: (qualified_identifier scope: (_) @scope name: (_) @name))
    (reference_declarator (function_declarator declarator: (qualified_identifier scope: (_) @scope name: (_) @name)))
    (pointer_declarator declarator: (function_declarator declarator: (qualified_identifier scope: (_) @scope name: (_) @name)))
  ]
  (field_initializer_list)? @body body: (_) @body (#set! kind "method")) @item
(function_definition
  declarator: [
    (function_declarator declarator: [(identifier) (field_identifier) (operator_name) (destructor_name)] @name)
    (pointer_declarator declarator: (function_declarator declarator: (identifier) @name))
    (reference_declarator (function_declarator declarator: (identifier) @name))
  ]
  body: (_) @body (#set! kind "func")) @item

; Declarations: prototypes, fields, and variables.
(field_declaration declarator: [
  (function_declarator declarator: (_) @name)
  (reference_declarator (function_declarator declarator: (_) @name))
  (pointer_declarator declarator: (function_declarator declarator: (_) @name))
] (#set! kind "method")) @item
(declaration declarator: [
  (function_declarator declarator: (_) @name)
  (reference_declarator (function_declarator declarator: (_) @name))
  (pointer_declarator declarator: (function_declarator declarator: (_) @name))
] (#set! kind "func")) @item
(field_declaration declarator: [(field_identifier) @name (array_declarator declarator: (field_identifier) @name) (pointer_declarator declarator: (field_identifier) @name)] (#set! kind "field")) @item
(declaration
  declarator: [
    (identifier) @name
    (init_declarator declarator: (identifier) @name)
    (init_declarator declarator: (pointer_declarator declarator: (identifier) @name))
  ]
  (#set! kind "var")) @item
