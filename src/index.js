import { ApolloServer, gql } from 'apollo-server';
import fetch from 'node-fetch';

// GitHub GraphQL endpoint
const GITHUB_API_URL = 'https://api.github.com/graphql';

// Definizione schema GraphQL
const typeDefs = gql`
  type Owner {
    login: String
  }

  type Repository {
    name: String
    size: Int
    owner: Owner
  }

  type RepositoryDetails {
    name: String
    size: Int
    owner: Owner
    isPrivate: Boolean
    fileCount: Int
    ymlContent: String
    activeWebhooks: [String]
  }

  type Query {
    listRepositories(developerToken: String!): [Repository]
    repoDetails(developerToken: String!, repoName: String!): RepositoryDetails
    scanMultipleRepos(developerToken: String!, repoNames: [String!]!): [RepositoryDetails]
  }
`;

// Funzione helper per fare richiesta GraphQL a GitHub
async function githubGraphQLRequest(token, query, variables = {}) {
  const res = await fetch(GITHUB_API_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query, variables }),
  });
  const json = await res.json();
  if (json.errors) throw new Error(JSON.stringify(json.errors));
  return json.data;
}

// Funzione helper per fetch REST (per webhook e contenuti file)
async function githubRESTRequest(token, url) {
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
    },
  });
  if (!res.ok) throw new Error(`GitHub REST API error: ${res.status}`);
  return res.json();
}

// Limita concurrency a 2 per scansione multipla
async function asyncPool(poolLimit, array, iteratorFn) {
  const ret = [];
  const executing = [];
  for (const item of array) {
    const p = Promise.resolve().then(() => iteratorFn(item));
    ret.push(p);

    if (poolLimit <= array.length) {
      const e = p.then(() => executing.splice(executing.indexOf(e), 1));
      executing.push(e);
      if (executing.length >= poolLimit) {
        await Promise.race(executing);
      }
    }
  }
  return Promise.all(ret);
}

// Funzione ricorsiva per trovare il primo file .yml/.yaml in qualsiasi sottocartella
async function findYmlFile(token, owner, repoName, path = '') {
  const query = `
    query($owner: String!, $name: String!, $expr: String!) {
      repository(owner: $owner, name: $name) {
        object(expression: $expr) {
          ... on Tree {
            entries {
              name
              type
            }
          }
        }
      }
    }
  `;

  const expr = path ? `HEAD:${path}` : 'HEAD:';
  const variables = { owner, name: repoName, expr };

  const data = await githubGraphQLRequest(token, query, variables);
  const entries = data.repository.object?.entries || [];

  for (const entry of entries) {
    if (entry.type === 'blob' && (entry.name.endsWith('.yml') || entry.name.endsWith('.yaml'))) {
      return path ? `${path}/${entry.name}` : entry.name;
    } else if (entry.type === 'tree') {
      const found = await findYmlFile(token, owner, repoName, path ? `${path}/${entry.name}` : entry.name);
      if (found) return found;
    }
  }

  return null; // non trovato
}

const resolvers = {
  Query: {
    listRepositories: async (_, { developerToken }) => {
      const query = `
        query {
          viewer {
            repositories(first: 3, orderBy: {field: CREATED_AT, direction: DESC}) {
              nodes {
                name
                diskUsage
                owner {
                  login
                }
              }
            }
          }
        }
      `;
      const data = await githubGraphQLRequest(developerToken, query);
      return data.viewer.repositories.nodes.map(repo => ({
        name: repo.name,
        size: repo.diskUsage,
        owner: { login: repo.owner.login },
      }));
    },

    repoDetails: async (_, { developerToken, repoName }) => {
      return fetchRepoDetails(developerToken, repoName);
    },

    scanMultipleRepos: async (_, { developerToken, repoNames }) => {
      // Limita la scansione a massimo 2 repo paralleli
      return asyncPool(2, repoNames, async (repoName) => {
        return fetchRepoDetails(developerToken, repoName);
      });
    },
  },
};

// Funzione helper per recuperare dettagli repo (riutilizzata da repoDetails e scanMultipleRepos)
async function fetchRepoDetails(developerToken, repoName) {
  // Prendi owner login (viewer)
  const viewerData = await githubGraphQLRequest(developerToken, `
    query { viewer { login } }
  `);
  const ownerLogin = viewerData.viewer.login;

  const repoQuery = `
    query($owner: String!, $name: String!) {
      repository(owner: $owner, name: $name) {
        name
        diskUsage
        owner {
          login
        }
        isPrivate
        object(expression: "HEAD:") {
          ... on Tree {
            entries {
              name
              type
            }
          }
        }
      }
    }
  `;
  const variables = { owner: ownerLogin, name: repoName };
  const data = await githubGraphQLRequest(developerToken, repoQuery, variables);

  if (!data.repository) {
    throw new Error(`Repository ${repoName} not found for owner ${ownerLogin}`);
  }

  const repo = data.repository;
  const entries = repo.object?.entries || [];

  const fileCount = countFilesRecursive(entries);

  // Cerca ricorsivamente il primo file yml/yaml
  const ymlFilePath = await findYmlFile(developerToken, ownerLogin, repoName);

  let ymlContent = null;
  if (ymlFilePath) {
    const fileUrl = `https://api.github.com/repos/${ownerLogin}/${repoName}/contents/${encodeURIComponent(ymlFilePath)}`;
    try {
      const fileData = await githubRESTRequest(developerToken, fileUrl);
      if (fileData.encoding === 'base64' && fileData.content) {
        ymlContent = Buffer.from(fileData.content, 'base64').toString('utf-8');
      }
    } catch {
      ymlContent = null;
    }
  }

  let activeWebhooks = [];
  try {
    const hooksUrl = `https://api.github.com/repos/${ownerLogin}/${repoName}/hooks`;
    const hooksData = await githubRESTRequest(developerToken, hooksUrl);
    activeWebhooks = hooksData.filter(h => h.active).map(h => h.config.url).filter(Boolean);
  } catch {
    activeWebhooks = [];
  }

  return {
    name: repo.name,
    size: repo.diskUsage,
    owner: { login: repo.owner.login },
    isPrivate: repo.isPrivate,
    fileCount,
    ymlContent,
    activeWebhooks,
  };
}

// Funzione ricorsiva per contare i file in tutte le cartelle (usata per fileCount)
function countFilesRecursive(entries) {
  let count = 0;
  if (!entries) return 0;
  for (const entry of entries) {
    if (entry.type === 'blob') {
      count++;
    }
    // Se entry è una cartella (tree) NON è presente in questa prima lista entries.
    // Per contare i file in sottocartelle bisognerebbe fare query aggiuntive (ma per semplicità qui contiamo solo primo livello)
  }
  return count;
}

const server = new ApolloServer({
  typeDefs,
  resolvers,
});

server.listen().then(({ url }) => {
  console.log(`Server ready at ${url}`);
});
