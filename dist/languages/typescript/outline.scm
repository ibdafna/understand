; TypeScript symbols (also used for TSX). Captures and properties are described in src/extract/symbols.ts.
; Declarations come before the export fallbacks: when two patterns find the same item, the earlier one wins.

(import_statement source: (_) @key (#set! kind "import") (#set! sig "full") (#set! qualify "no")) @item
(import_statement (#set! kind "import") (#set! sig "full") (#set! qualify "no")) @item @key

(function_declaration name: (_) @name body: (_) @body (#set! kind "function")) @item
(generator_function_declaration name: (_) @name body: (_) @body (#set! kind "function")) @item
; Overload signatures fold into the implementation that follows them.
(function_signature name: (_) @name (#set! kind "function") (#set! fold "next")) @item

(class_declaration name: (_) @name body: (_) @body (#set! kind "class") (#set! container "true")) @item
(abstract_class_declaration name: (_) @name body: (_) @body (#set! kind "class") (#set! container "true")) @item
(interface_declaration name: (_) @name body: (_) @body (#set! kind "interface")) @item
(type_alias_declaration name: (_) @name (#set! kind "type")) @item
(enum_declaration name: (_) @name body: (_) @body (#set! kind "enum")) @item
(internal_module name: (_) @name body: (_) @body (#set! kind "namespace") (#set! container "true")) @item
(module name: (_) @name body: (_) @body (#set! kind "namespace") (#set! container "true")) @item

; Variables; a function value makes it a function.
(lexical_declaration . (variable_declarator name: (_) @name value: [
  (arrow_function body: (_) @body) (function_expression body: (_) @body) (generator_function body: (_) @body)
]) (#set! kind "function")) @item
(variable_declaration . (variable_declarator name: (_) @name value: [
  (arrow_function body: (_) @body) (function_expression body: (_) @body) (generator_function body: (_) @body)
]) (#set! kind "function")) @item
(lexical_declaration kind: _ @kind (variable_declarator name: (_) @name)) @item
(variable_declaration (variable_declarator name: (_) @name) (#set! kind "var")) @item

; Class members. Accessors key apart from a same-named method.
(method_definition ["get" "set"] @key.prefix name: (_) @name body: (_) @body (#set! kind "method")) @item
(method_definition name: (_) @name body: (_) @body (#set! kind "method")) @item
(method_signature ["get" "set"] @key.prefix name: (_) @name (#set! kind "method")) @item
(method_signature name: (_) @name (#set! kind "method")) @item
(abstract_method_signature ["get" "set"] @key.prefix name: (_) @name (#set! kind "method")) @item
(abstract_method_signature name: (_) @name (#set! kind "method")) @item
(public_field_definition name: (_) @name (#set! kind "field")) @item

; export statements that declare nothing themselves.
(export_statement "default" (#set! kind "export") (#set! key "default") (#set! name "text") (#set! sig "full") (#set! qualify "no")) @item
(export_statement (export_clause) @key (#set! kind "export") (#set! name "text") (#set! sig "full") (#set! qualify "no")) @item
(export_statement source: (_) @key (#set! kind "export") (#set! key.prefix "*:") (#set! name "text") (#set! sig "full") (#set! qualify "no")) @item
(export_statement (#set! kind "export") (#set! name "text") (#set! sig "full") (#set! qualify "no")) @item @key
