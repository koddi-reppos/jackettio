import {createHash} from 'crypto';
import {ERROR} from './const.js';
import {wait, isVideo} from '../util.js';
import config from '../config.js';

export default class RealDebrid {

  static id = 'realdebrid';
  static name = 'Real-Debrid';
  static shortName = 'RD';
  static configFields = [
    {
      type: 'text', 
      name: 'debridApiKey', 
      label: `Real-Debrid API Key`, 
      required: true, 
      href: {value: 'https://real-debrid.com/apitoken', label:'Get API Key Here'}
    }
  ];

  #apiKey;
  #ip;

  constructor(userConfig) {
    Object.assign(this, this.constructor);
    this.cacheCheckAvailable = config.enableCacheCheck;
    this.#apiKey = userConfig.debridApiKey;
    this.#ip = userConfig.ip || '';
  }

  async getTorrentsCached(torrents, isValidCachedFiles){
    return [];
  }

  async getProgressTorrents(torrents){
    const res = await this.#request('GET', '/torrents');
    return res.reduce((progress, torrent) => {
      progress[torrent.hash] = {
        percent: torrent.progress || 0,
        speed: torrent.speed || 0
      }
      return progress;
    }, {});
  }

  async getFilesFromHash(infoHash){
    return this.getFilesFromMagnet(`magnet:?xt=urn:btih:${infoHash}`, infoHash);
  }

  async getFilesFromMagnet(magnet, infoHash){
    const torrentId = await this.#searchTorrentIdByHash(infoHash);
    if(torrentId)return this.#getFilesFromTorrent(torrentId);
    const body = new FormData();
    body.append('magnet', magnet);
    const res = await this.#request('POST', `/torrents/addMagnet`, {body});
    return this.#getFilesFromTorrent(res.id);
  }

  async getFilesFromBuffer(buffer, infoHash){
    const torrentId = await this.#searchTorrentIdByHash(infoHash);
    if(torrentId)return this.#getFilesFromTorrent(torrentId);
    const body = buffer;
    const res = await this.#request('PUT', `/torrents/addTorrent`, {body});
    return this.#getFilesFromTorrent(res.id);
  }

  async getDownload(file){

    const [torrentId, fileId] = file.id.split(':');

    let torrent = await this.#request('GET', `/torrents/info/${torrentId}`);
    let body;

    if(torrent.status == 'waiting_files_selection'){

      const fileIds = torrent.files.filter(file => isVideo(file.path)).map(file => file.id);
      
      body = new FormData();
      body.append('files', fileIds.join(','));

      await this.#request('POST', `/torrents/selectFiles/${torrentId}`, {body});
      torrent = await this.#request('GET', `/torrents/info/${torrentId}`);

    }

    if(torrent.status != 'downloaded'){
      const maxRetries = config.debridMaxRetries;
      const pollingInterval = config.debridPollingInterval;
      const timeout = config.debridDownloadTimeout * 1000;
      const startTime = Date.now();

      console.log(`Torrent ${torrentId} not ready (status: ${torrent.status}), checking if cached...`);

      for(let retry = 0; retry < maxRetries; retry++){
        if(Date.now() - startTime > timeout){
          console.log(`Torrent ${torrentId} timeout after ${Math.round((Date.now() - startTime) / 1000)}s`);
          throw new Error(ERROR.NOT_READY);
        }

        if(['error', 'virus', 'dead'].includes(torrent.status)){
          console.log(`Torrent ${torrentId} failed: ${torrent.status}`);
          throw new Error(`Torrent failed: ${torrent.status}`);
        }

        if(torrent.status != 'magnet_conversion'){
          console.log(`Torrent ${torrentId} not cached (status: ${torrent.status}). Only cached torrents are instant.`);
          throw new Error(ERROR.NOT_READY);
        }

        console.log(`Check ${retry + 1}/${maxRetries}: status=${torrent.status}, waiting ${pollingInterval}ms...`);
        await wait(pollingInterval);
        
        torrent = await this.#request('GET', `/torrents/info/${torrentId}`);
        
        if(torrent.status == 'downloaded'){
          console.log(`Torrent ${torrentId} cached! Ready after ${Math.round((Date.now() - startTime) / 1000)}s`);
          break;
        }
      }

      if(torrent.status != 'downloaded'){
        console.log(`Torrent ${torrentId} not cached after ${Math.round((Date.now() - startTime) / 1000)}s`);
        throw new Error(ERROR.NOT_READY);
      }
    }

    const linkIndex = torrent.files.filter(file => file.selected).findIndex(file => file.id == fileId);
    const link = torrent.links[linkIndex] || false;

    if(!link){
      throw new Error(`LinkIndex or link not found`);
    }

    body = new FormData();
    body.append('link', link);
    const res = await this.#request('POST', '/unrestrict/link', {body});
    return res.download;

  }

  async getUserHash(){
    return createHash('md5').update(this.#apiKey).digest('hex');
  }

  // Return false when a non video file is available in the cache to avoid rar files
  #isVideoCache(cache){
    return !Object.values(cache).find(file => !isVideo(file.filename));
  }

  async #getFilesFromTorrent(id){

    let torrent = await this.#request('GET', `/torrents/info/${id}`);

    return torrent.files.map((file, index) => {
      return {
        name: file.path.split('/').pop(),
        size: file.bytes,
        id: `${torrent.id}:${file.id}`,
        url: '',
        ready: null
      };
    });

  }

  async #searchTorrentIdByHash(hash){

    const torrents = await this.#request('GET', `/torrents`);

    for(let torrent of torrents){
      if(torrent.hash == hash && ['magnet_conversion', 'waiting_files_selection', 'queued', 'downloading', 'downloaded'].includes(torrent.status)){
        return torrent.id;
      }
    }

  }

  async #request(method, path, opts){

    opts = opts || {};
    opts = Object.assign(opts, {
      method,
      headers: Object.assign(opts.headers || {}, {
        'accept': 'application/json',
        'authorization': `Bearer ${this.#apiKey}`
      }),
      query: opts.query || {}
    });

    if(method == 'POST' || method == 'PUT'){
      opts.body = opts.body || new FormData();
      if(this.#ip && opts.body instanceof FormData)opts.body.append('ip', this.#ip);
    }

    const url = `https://api.real-debrid.com/rest/1.0${path}?${new URLSearchParams(opts.query).toString()}`;
    const res = await fetch(url, opts);
    let data;

    try {
      data = await res.json();
    }catch(err){
      data = res.status >= 400 ? {error_code: -2, error: `Empty response ${res.status}`} : {};
    }

    if(data.error_code){
      switch(data.error_code){
        case 8:
          throw new Error(ERROR.EXPIRED_API_KEY);
        case 9:
          throw new Error(ERROR.ACCESS_DENIED);
        case 10:
        case 11:
          throw new Error(ERROR.TWO_FACTOR_AUTH);
        case 20:
          throw new Error(ERROR.NOT_PREMIUM);
        default:
          throw new Error(`Invalid RD api result: ${JSON.stringify(data)}`);
      }
    }

    return data;

  }

}