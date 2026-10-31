-- Conversation memory (R-23): the text of each `memory` assertion, erased on a confirmed forget
CREATE TABLE memory_texts (
  assertion_id INTEGER PRIMARY KEY REFERENCES assertions(id),
  text TEXT NOT NULL,               -- the fact, as the processor worded it
  quote TEXT NOT NULL               -- the words of the message it rests on
);

-- FTS5 index of the memory text, kept in step with memory_texts by triggers
CREATE VIRTUAL TABLE memory_search USING fts5(
  text, content = 'memory_texts', content_rowid = 'assertion_id', tokenize = 'unicode61 remove_diacritics 2'
);
INSERT INTO memory_search (memory_search, rank) VALUES ('secure-delete', 1);

CREATE TRIGGER memory_texts_indexed AFTER INSERT ON memory_texts BEGIN
  INSERT INTO memory_search (rowid, text) VALUES (NEW.assertion_id, NEW.text);
END;

CREATE TRIGGER memory_texts_unindexed AFTER DELETE ON memory_texts BEGIN
  INSERT INTO memory_search (memory_search, rowid, text) VALUES ('delete', OLD.assertion_id, OLD.text);
END;
