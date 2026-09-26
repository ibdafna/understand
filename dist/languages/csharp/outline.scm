; C# symbols. Captures and properties are described in src/extract/symbols.ts.

(using_directive (_) @key (#set! kind "import") (#set! sig "full") (#set! qualify "no")) @item

; Namespaces hold members without naming them: file-scoped namespaces (`namespace X;`) can't, so neither do blocks.
(namespace_declaration name: (_) @name body: (_) @body (#set! kind "namespace") (#set! container "true") (#set! qualify.members "no")) @item
(file_scoped_namespace_declaration name: (_) @name (#set! kind "namespace")) @item
(class_declaration name: (_) @name body: (_) @body (#set! kind "class") (#set! container "true")) @item
(struct_declaration name: (_) @name body: (_) @body (#set! kind "struct") (#set! container "true")) @item
(interface_declaration name: (_) @name body: (_) @body (#set! kind "interface") (#set! container "true")) @item
(record_declaration name: (_) @name (#set! kind "class") (#set! container "true")) @item
(enum_declaration name: (_) @name body: (_) @body (#set! kind "enum")) @item
(delegate_declaration name: (_) @name (#set! kind "type")) @item

; A local function in top-level statements (Program.cs) is a symbol of its own.
(global_statement (local_function_statement name: (_) @name body: (_)? @body) (#set! kind "func")) @item

(method_declaration name: (_) @name body: (_)? @body (#set! kind "method")) @item
(constructor_declaration name: (_) @name body: (_)? @body (#set! kind "method")) @item
(property_declaration name: (_) @name (#set! kind "field")) @item
(field_declaration (variable_declaration (variable_declarator name: (_) @name)) (#set! kind "field")) @item
(event_field_declaration (variable_declaration (variable_declarator name: (_) @name)) (#set! kind "field")) @item
