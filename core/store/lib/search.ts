import Vue from 'vue'
import map from 'lodash-es/map'
import { slugify } from '../helpers'
import { currentStoreView } from './multistore'
import { sha1 } from 'object-hash'
import fetch from 'isomorphic-fetch'
import rootStore from '../'
import HttpQuery from '../types/search/HttpQuery'
import ESQuery from '../types/search/ESQuery'
import ESResponse from '../types/search/ESResponse'

export function isOnline () {
  if (typeof navigator !== 'undefined') {
    return navigator.onLine
  } else {
    return true // SSR
  }
}

const buildURLQuery = obj => Object.entries(obj).map(pair => pair.map(encodeURIComponent).join('=')).join('&')

/**
 * Execute ElasticSearch query
 */
function search (elasticQuery) {
  const storeView = currentStoreView()
  let url = storeView.elasticsearch.host
  if (!url.startsWith('/') && !url.startsWith('http')) {
    url = 'http://' + url
  }
  const httpQuery: HttpQuery = {
    size: elasticQuery.size,
    from: elasticQuery.from,
    sort: elasticQuery.sort
  }
  if (elasticQuery._sourceExclude) {
    httpQuery._source_exclude = elasticQuery._sourceExclude.join(',')
  }
  if (elasticQuery._sourceInclude) {
    httpQuery._source_include = elasticQuery._sourceInclude.join(',')
  }
  if (elasticQuery.q) {
    httpQuery.q = elasticQuery.q
  }

  if (!elasticQuery.index || !elasticQuery.type) {
    throw new Error('elasticQuery.index and elasticQuery.type are required arguments for executing ElasticSearch query')
  }

  url = url + '/' + encodeURIComponent(elasticQuery.index) + '/' + encodeURIComponent(elasticQuery.type) + '/_search'
  url = url + '?' + buildURLQuery(httpQuery)

  return fetch(url, { method: 'POST',
    mode: 'cors',
    headers: {
      'Accept': 'application/json',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(elasticQuery.body)
  }).then(resp => { return resp.json() }).catch(err => {
    if (err.message.indexOf('fetch') >= 0 || !isOnline()) {
      console.error('Offline mode ' + err.message)
    } else {
      throw new Error(err)
    }
  })
}
/**
 * Helper function to handle ElasticSearch Results
 * @param {Object} resp result from ES call
 * @param {Int} start pagination data
 * @param {Int} size pagination data
 */
function _handleEsResult (resp, start = 0, size = 50): ESResponse {
  if (resp == null) {
    if (isOnline()) {
      throw new Error('Invalid ES result - null not exepcted')
    } else {
      return null // empty result but not exception raised - we're in offline mode
    }
  }
  if (resp.hasOwnProperty('hits')) {
    return {
      items: map(resp.hits.hits, (hit) => {
        return Object.assign(hit._source, { _score: hit._score, slug: (hit._source.hasOwnProperty('url_key') && rootStore.state.config.products.useMagentoUrlKeys) ? hit._source.url_key : (hit._source.hasOwnProperty('name') ? slugify(hit._source.name) + '-' + hit._source.id : '') }) // TODO: assign slugs server side
      }), // TODO: add scoring information
      total: resp.hits.total,
      start: start,
      perPage: size,
      aggregations: resp.aggregations
    }
  } else {
    if (resp.error) {
      throw new Error(JSON.stringify(resp.error))
    } else {
      throw new Error('Unknown error with ES result in _handleEsResult')
    }
  }
}

/**
 * Search ElasticSearch catalog of products using simple text query
 * Use bodybuilder to build the query, aggregations etc: http://bodybuilder.js.org/
 * @param {Object} query elasticSearch request body
 * @param {Int} start start index
 * @param {Int} size page size
 * @return {Promise}
 */
export function quickSearchByQuery ({ query, start = 0, size = 50, entityType = 'product', sort = '', index = null, excludeFields = null, includeFields = null }): Promise<ESResponse> {
  if (size <= 0) size = 50
  if (start < 0) start = 0

  return new Promise((resolve, reject) => {
    const storeView = currentStoreView()
    const esQuery: ESQuery = {
      index: index || storeView.elasticsearch.index, // TODO: add grouped product and bundled product support
      type: entityType,
      body: query,
      size: size,
      from: start,
      sort: sort
    }

    if (excludeFields) esQuery._sourceExclude = excludeFields
    if (includeFields) esQuery._sourceInclude = includeFields

    if (rootStore.state.config.usePriceTiers && (entityType === 'product') && rootStore.state.user.groupId) {
      esQuery.body.groupId = rootStore.state.user.groupId
    }

    const cache = Vue.prototype.$db.elasticCacheCollection // switch to appcache?
    let servedFromCache = false
    const cacheKey = sha1(esQuery)
    const benchmarkTime = new Date()

    cache.getItem(cacheKey, (err, res) => {
      if (err) console.log(err)
      if (res !== null) {
        res.cache = true
        res.noresults = false
        res.offline = !isOnline() // TODO: refactor it to checking ES heartbit
        resolve(res)
        console.debug('Result from cache for ' + cacheKey + ' (' + entityType + '), ms=' + (new Date().getTime() - benchmarkTime.getTime()))
        servedFromCache = true
      } else {
        if (!isOnline()) {
          console.debug('No results and offline ' + cacheKey + ' (' + entityType + '), ms=' + (new Date().getTime() - benchmarkTime.getTime()))
          res = {
            items: [],
            total: 0,
            start: 0,
            perPage: 0,
            aggregations: {},
            offline: true,
            cache: true,
            noresults: true
          }
          servedFromCache = true
          resolve(res)
        }
      }
    }).catch((err) => {
      console.error('Cannot read cache for ' + cacheKey + ', ' + err)
    })

    /* use only for cache */
    if (esQuery.body.groupId) {
      delete esQuery.body.groupId
    }

    if (rootStore.state.config.usePriceTiers && rootStore.state.user.groupToken) {
      esQuery.body.groupToken = rootStore.state.user.groupToken
    }

    search(esQuery).then((resp) => { // we're always trying to populate cache - when online
      const res = _handleEsResult(resp, start, size)

      if (res) { // otherwise it can be just a offline mode
        cache.setItem(cacheKey, res).catch((err) => { console.error('Cannot store cache for ' + cacheKey + ', ' + err) })
        if (!servedFromCache) { // if navigator onLine == false means ES is unreachable and probably this will return false; sometimes returned false faster than indexedDb cache returns result ...
          console.debug('Result from ES for ' + cacheKey + ' (' + entityType + '),  ms=' + (new Date().getTime() - benchmarkTime.getTime()))
          res.cache = false
          res.noresults = false
          res.offline = false
          resolve(res)
        }
      }
    }).catch(err => {
      reject(err)
    })
  })
}

/**
   * Search ElasticSearch catalog of products using simple text query
   * @param {String} queryText full text search query
   * @param {Int} start start index
   * @param {Int} size page size
   * @return {Promise}
   */
export function quickSearchByText ({ queryText, start = 0, size = 50 }) {
  if (size <= 0) size = 50
  if (start < 0) start = 0

  return new Promise((resolve, reject) => {
    const storeView = currentStoreView()
    search({
      index: storeView.elasticsearch.index, // TODO: add grouped prodduct and bundled product support
      type: 'product',
      q: queryText,
      size: size,
      from: start
    }).then((resp) => {
      resolve(_handleEsResult(resp, start, size))
    }).catch((err) => {
      reject(err)
    })
  })
}
