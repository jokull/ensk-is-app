import { Asset } from "expo-asset";
import * as FileSystem from "expo-file-system";
import * as SQLite from "expo-sqlite";
import { StatusBar } from "expo-status-bar";
import Fuse from "fuse.js";
import React, { useEffect, useState } from "react";
import { Text, TextInput, View } from "react-native";
import { KeyboardAwareFlatList } from "react-native-keyboard-aware-scroll-view";
import useSWR, { SWRConfig } from "swr";

function useDebounce(value: string, delay: number = 200) {
  // State and setters for debounced value
  const [debouncedValue, setDebouncedValue] = useState(value);
  useEffect(
    () => {
      // Update debounced value after delay
      const handler = setTimeout(() => {
        setDebouncedValue(value);
      }, delay);
      // Cancel the timeout if value changes (also on delay change or unmount)
      // This is how we prevent debounced value from updating if value is changed ...
      // .. within the delay period. Timeout gets cleared and restarted.
      return () => {
        clearTimeout(handler);
      };
    },
    [value, delay] // Only re-call effect if value or delay changes
  );
  return debouncedValue;
}

function execute(db: SQLite.WebSQLDatabase, sql: string, args: string[] = []) {
  return new Promise<SQLite.ResultSet["rows"]>((resolve, reject) => {
    db.exec([{ sql, args }], false, (err, res) => {
      if (err) reject(err);
      if (res) {
        if ("error" in res[0]) return reject(res[0].error);
        resolve(res[0].rows);
      }
    });
  });
}

async function openDatabase(): Promise<SQLite.WebSQLDatabase> {
  const dbPath = FileSystem.documentDirectory + "SQLite/dict.db";
  if (
    !(await FileSystem.getInfoAsync(FileSystem.documentDirectory + "SQLite"))
      .exists
  ) {
    await FileSystem.makeDirectoryAsync(
      FileSystem.documentDirectory + "SQLite"
    );
  }
  if (!(await FileSystem.getInfoAsync(dbPath)).exists) {
    await FileSystem.downloadAsync(
      Asset.fromModule(require("./dict.db")).uri,
      dbPath
    );
  }
  return SQLite.openDatabase("dict.db");
}

interface Row {
  id: number;
  word: string;
  definition: string;
  ipa_uk: string;
  ipa_us: string;
}

async function getRandom(db: SQLite.WebSQLDatabase): Promise<Row> {
  const results = await execute(
    db,
    `
    select
      id, word, definition, ipa_uk, ipa_us
    from
      dictionary
    order by RANDOM()
    limit 1;
    `
  );
  return results[0] as unknown as Row;
}

async function getSearch(
  db: SQLite.WebSQLDatabase,
  query: string
): Promise<Row[]> {
  const results = (await execute(
    db,
    `
    select
      id, word, definition, ipa_uk, ipa_us
    from
      dictionary
    where rowid in (
      select rowid
      from dictionary_fts
      where dictionary_fts match ?
      order by rank)
    limit 101
  `,
    [`${query}*`]
  )) as unknown as Row[];

  const fuse = new Fuse(results, {
    keys: ["word"],
    findAllMatches: true,
    includeScore: true,
  })
    .search(query)
    .map(({ item }) => item);
  return [
    // Prioritize fuse results because it's good at fuzzy ranking, giving whole word results better
    // scores
    ...fuse,
    // ... but also include the rest of the SQLite FTS results
    ...results.filter((row) => !fuse.find(({ id }) => id === row.id)),
  ];
}

function App() {
  const { data: db } = useSWR("db", openDatabase);
  return (
    <View style={{ marginVertical: 16 }}>
      {db ? (
        <Search db={db} />
      ) : (
        <View
          style={{ flex: 1, alignItems: "center", justifyContent: "center" }}
        >
          <Text
            style={{
              fontWeight: "400",
              fontSize: 18,
              textTransform: "uppercase",
              letterSpacing: 3,
            }}
          >
            Loading
          </Text>
        </View>
      )}
      <StatusBar style="auto" />
    </View>
  );
}

function Results({ results }: { results: Row[] }) {
  return (
    <KeyboardAwareFlatList
      data={results}
      keyExtractor={({ id }) => id}
      style={{ paddingVertical: 16, marginBottom: 150, paddingHorizontal: 16 }}
      renderItem={({ item: result }) => (
        <View
          key={result.id}
          style={{
            paddingBottom: 12,
            ...(result.id === results.at(-1)?.id
              ? {}
              : {
                  borderBottomWidth: 1,
                  borderBottomColor: "rgba(0, 0, 0, 0.1)",
                  marginBottom: 12,
                }),
          }}
        >
          <View>
            <Text style={{ fontWeight: "500", fontSize: 18, marginBottom: 4 }}>
              {result.word}
            </Text>
          </View>
          <View>
            <Text style={{ fontSize: 14 }}>{result.definition}</Text>
          </View>
        </View>
      )}
    />
  );
}

function Search({ db }: { db: SQLite.WebSQLDatabase }) {
  const [query, setQuery] = useState("");
  const debouncedQuery = useDebounce(query, 200)?.toLocaleLowerCase();
  const { data: random } = useSWR("random", () => getRandom(db));
  const { data: results, isValidating } = useSWR(
    `search/${debouncedQuery || ""}`,
    () => (debouncedQuery ? getSearch(db, debouncedQuery) : undefined)
  );
  return (
    <View style={{ width: "100%" }}>
      <View
        style={{
          position: "relative",
          marginTop: 24,
          marginBottom: 4,
          marginHorizontal: 16,
        }}
      >
        <TextInput
          style={{
            borderRadius: 8,
            backgroundColor: "#F0F0F0",
            paddingHorizontal: 12,
            paddingVertical: 12,
            marginTop: 12,
            fontSize: 18,
            width: "100%",
          }}
          keyboardType="web-search"
          value={query}
          onChangeText={(value) => {
            setQuery(value);
            // setInitial(null);
          }}
          placeholder="Leita að ensku orði"
          autoFocus={true}
        />
      </View>
      <Results
        results={
          Array.isArray(results) && debouncedQuery && !isValidating
            ? results
            : random
            ? [random]
            : []
        }
      />
    </View>
  );
}

export default function () {
  return (
    <SWRConfig
      value={{
        provider: () => new Map(),
        isOnline() {
          return true;
        },
        isVisible() {
          return true;
        },
        initFocus(callback) {},
        initReconnect(callback) {},
      }}
    >
      <App />
    </SWRConfig>
  );
}
