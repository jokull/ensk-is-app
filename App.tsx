import { Asset } from "expo-asset";
import * as FileSystem from "expo-file-system";
import * as SQLite from "expo-sqlite";
import { StatusBar } from "expo-status-bar";
import Fuse from "fuse.js";
import * as Network from "expo-network";
import React, { useEffect, useState } from "react";
import {
  FlatList,
  KeyboardAvoidingView,
  Platform,
  SafeAreaView,
  Text,
  TextInput,
  View,
} from "react-native";
import useSWR, { SWRConfig } from "swr";
import AsyncStorage from "@react-native-async-storage/async-storage";

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

const DIR = FileSystem.documentDirectory + "SQLite";
const DB_PATH = DIR + "/dict.db";

async function openDatabase(): Promise<SQLite.WebSQLDatabase> {
  // Create the SQLite directory (needed by the expo sqlite library)
  if (!(await FileSystem.getInfoAsync(DIR)).exists) {
    await FileSystem.makeDirectoryAsync(DIR);
  }

  // Move the asset to the sqlite directory if there is no db there yet (on first app boot)
  if (!(await FileSystem.getInfoAsync(DB_PATH)).exists) {
    await FileSystem.downloadAsync(
      Asset.fromModule(require("./dict.db")).uri,
      DB_PATH
    );
  }

  return SQLite.openDatabase("dict.db");
}

async function updateDatabase(onUpdate: () => void): Promise<void> {
  const daysInMs = 24 * 60 * 60 * 1000;
  const networkState = await Network.getNetworkStateAsync();
  const lastSavedRaw = await AsyncStorage.getItem("@fetch");
  let lastSaved = lastSavedRaw ? new Date(JSON.parse(lastSavedRaw)) : undefined;

  if (!lastSaved || !networkState.isConnected) {
    // `lastSaved` won't be set on the first app boot
    await AsyncStorage.setItem("@fetch", JSON.stringify(new Date().valueOf()));
  } else {
    if (new Date().valueOf() - lastSaved.valueOf() > 7 * daysInMs) {
      // It has been more than 7 days since the last fetch, time to get an updated dictionary
      const response = await FileSystem.downloadAsync(
        "https://github.com/jokull/ensk-web/raw/main/src/dict.db",
        DB_PATH
      );
      if (response.status >= 200 && response.status < 400) {
        lastSaved = new Date();
        await AsyncStorage.setItem(
          "@fetch",
          JSON.stringify(lastSaved.valueOf())
        );
        onUpdate();
      }
    }
  }
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
  const { data: db, mutate } = useSWR("db", openDatabase, {
    onSuccess: (db) => {
      updateDatabase(async () => {
        await db.closeAsync();
        mutate();
      });
    },
  });
  return (
    <SafeAreaView style={[{ flex: 1, display: "flex" }]}>
      {db ? (
        <View
          style={{
            flex: 1,
            height: "100%",
          }}
        >
          <Search db={db} />
        </View>
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
    </SafeAreaView>
  );
}

function Search({ db }: { db: SQLite.WebSQLDatabase }) {
  const [query, setQuery] = useState("");
  const debouncedQuery = useDebounce(query, 200)?.toLocaleLowerCase();
  const { data: random, mutate: refetchRandom } = useSWR("random", () =>
    getRandom(db)
  );
  const { data: results, isValidating } = useSWR(
    `search/${debouncedQuery || ""}`,
    () => (debouncedQuery ? getSearch(db, debouncedQuery) : undefined)
  );
  return (
    <>
      <TextInput
        style={{
          borderRadius: 8,
          backgroundColor: "#F0F0F0",
          paddingHorizontal: 12,
          paddingVertical: 12,
          marginHorizontal: 16,
          marginTop: 12,
          fontSize: 18,
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
      <Results
        onRefresh={() => refetchRandom()}
        results={
          Array.isArray(results) && debouncedQuery && !isValidating
            ? results
            : random
            ? [random]
            : []
        }
      />
    </>
  );
}

function Results({
  results,
  onRefresh,
}: {
  results: Row[];
  onRefresh: () => void;
}) {
  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === "ios" ? "padding" : "height"}
      style={{ flex: 1 }}
    >
      <FlatList
        data={results}
        refreshing={false}
        onRefresh={onRefresh}
        style={{
          paddingVertical: 16,
          paddingHorizontal: 18,
          height: "100%",
        }}
        renderItem={({ item: result }) => (
          <View
            key={result.id}
            style={{
              paddingBottom: 12,
              ...(result.id === results.at(-1)?.id
                ? { marginBottom: 100 }
                : {
                    borderBottomWidth: 1,
                    borderBottomColor: "rgba(0, 0, 0, 0.1)",
                    marginBottom: 12,
                  }),
            }}
          >
            <View>
              <Text
                style={{ fontWeight: "500", fontSize: 18, marginBottom: 4 }}
              >
                {result.word}
              </Text>
            </View>
            <View>
              <Text style={{ fontSize: 14 }}>{result.definition}</Text>
            </View>
          </View>
        )}
      />
    </KeyboardAvoidingView>
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
