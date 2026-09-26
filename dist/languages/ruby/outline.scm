; Ruby symbols. Captures and properties are described in src/extract/symbols.ts.

(program (call method: (identifier) @m arguments: (argument_list (string) @key)
  (#match? @m "^(require|require_relative|load)$") (#set! kind "import") (#set! sig "full")) @item)

(module name: (_) @name body: (_)? @body (#set! kind "namespace") (#set! container "true")) @item
(class name: (_) @name body: (_)? @body (#set! kind "class") (#set! container "true")) @item
(method name: (_) @name body: (_)? @body (#set! kind "function") (#set! kind.member "method")) @item
(singleton_method object: (_) @key.prefix name: (_) @name body: (_)? @body (#set! kind "method")) @item
; A constant built with a block (`Item = Struct.new(...) do … end`): the block is its body.
(assignment left: (constant) @name right: (call block: [(do_block) (block)] @body) (#set! kind "const")) @item
(assignment left: (constant) @name (#set! kind "const")) @item
