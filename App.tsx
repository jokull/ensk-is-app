import { Asset } from "expo-asset";
import * as FileSystem from "expo-file-system";
import * as SQLite from "expo-sqlite";
import { StatusBar } from "expo-status-bar";
import Fuse from "fuse.js";
import React, { useState } from "react";
import { StyleSheet, Text, TextInput, View } from "react-native";
import {
  KeyboardAwareFlatList,
  KeyboardAwareScrollView,
} from "react-native-keyboard-aware-scroll-view";
import useSWR, { SWRConfig } from "swr";

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
    order by RANDOM() limit 1
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
    <>
      {db ? <Search db={db} /> : <Text>Loading</Text>}
      <StatusBar style="auto" />
    </>
  );
}

function Results({ results }: { results: Row[] }) {
  return (
    <KeyboardAwareFlatList
      data={results}
      keyExtractor={({ id }) => id}
      style={{ padding: 12 }}
      renderItem={({ item: result }) => (
        <View key={result.id} style={{ marginBottom: 8 }}>
          <View>
            <Text style={{ fontWeight: "bold" }}>{result.word}</Text>
          </View>
          <View>
            <Text>{result.definition}</Text>
          </View>
        </View>
      )}
    />
  );
}

function Search({ db }: { db: SQLite.WebSQLDatabase }) {
  // const [initial, setInitial] = useState<Row | null>(null);
  const [query, setQuery] = useState("");
  const { data: random } = useSWR("random", getRandom);
  const { data: results } = useSWR(`search/${query}`, () =>
    query ? getSearch(db, query) : []
  );
  return (
    <View style={{ width: "100%" }}>
      <View
        style={{
          position: "relative",
          marginTop: 36,
          marginBottom: 4,
          marginHorizontal: 8,
        }}
      >
        <TextInput
          style={{
            borderRadius: 6,
            backgroundColor: "#F0F0F0",
            paddingHorizontal: 12,
            paddingVertical: 12,
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
      <Results results={results || (random ? [random] : []) || []} />
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

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#fff",
  },
});
