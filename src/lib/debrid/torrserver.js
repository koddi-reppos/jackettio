import {createHash} from 'crypto';
import {ERROR} from './const.js';
import {wait} from '../util.js';

export default class TorrServer {

  static id = 'torrserver';
  static name = 'TorrServer';
  static shortName = 'TS';
  static cacheCheckAvailable = false;
  static configFields = [
    {
      type: 'text', 
      name: 'torrserverUrl', 
      label: `TorrServer URL`, 
      required: true, 
      href: {value: 'https://github.com/YouROK/TorrServer', label:'TorrServer GitHub'}
    },
    {
      type: 'text', 
      name: 'torrserverUsername', 
      label: `TorrServer Username (opcional)`, 
      required: false
    },
    {
      type: 'password', 
      name: 'torrserverPassword', 
      label: `TorrServer Password (opcional)`, 
      required: false
    }
  ];

  #url;
  #username;
  #password;
  #ip;

  constructor(userConfig) {
    Object.assign(this, this.constructor);
    this.#url = userConfig.torrserverUrl?.replace(/\/$/, '');
    this.#username = userConfig.torrserverUsername || '';
    this.#password = userConfig.torrserverPassword || '';
    this.#ip = userConfig.ip || '';
  }

  async getTorrentsCached(torrents){
    return [];
  }

  async getProgressTorrents(torrents){
    const res = await this.#request('POST', '/torrents', {
      body: JSON.stringify({action: 'list'})
    });
    
    const torrentList = Array.isArray(res) ? res : [];
    
    return torrentList.reduce((progress, torrent) => {
      if(torrent.hash){
        progress[torrent.hash.toLowerCase()] = {
          percent: torrent.stat?.download_progress || 0,
          speed: torrent.stat?.download_speed || 0
        }
      }
      return progress;
    }, {});
  }

  async getFilesFromHash(infoHash){
    return this.getFilesFromMagnet(`magnet:?xt=urn:btih:${infoHash}`, infoHash);
  }

  async getFilesFromMagnet(magnet, infoHash){
    const body = JSON.stringify({
      action: 'add',
      link: magnet,
      save_to_db: true
    });
    
    const res = await this.#request('POST', '/torrents', {body});
    
    if(!res || !res.hash){
      throw new Error('Failed to add torrent to TorrServer');
    }
    
    return this.#getFilesFromTorrent(res.hash);
  }

  async getFilesFromBuffer(buffer, infoHash){
    const formData = new FormData();
    const blob = new Blob([buffer], {type: 'application/x-bittorrent'});
    formData.append('file', blob, 'torrent.torrent');
    formData.append('title', infoHash || 'Torrent');
    formData.append('save', 'true');
    
    const res = await this.#request('POST', '/torrent/upload', {body: formData, isFormData: true});
    
    if(!res || !res.hash){
      throw new Error('Failed to add torrent to TorrServer');
    }
    
    return this.#getFilesFromTorrent(res.hash);
  }

  async getDownload(file){
    return file.url;
  }

  async getUserHash(){
    return createHash('md5').update(this.#url + this.#username).digest('hex');
  }

  async #getFilesFromTorrent(hash){
    let attempts = 0;
    const maxAttempts = 30;
    
    while(attempts < maxAttempts){
      const body = JSON.stringify({
        action: 'get',
        hash: hash
      });
      
      const torrent = await this.#request('POST', '/torrents', {body});
      
      if(!torrent){
        throw new Error('Torrent not found');
      }
      
      if(torrent.file_stats && torrent.file_stats.length > 0){
        return torrent.file_stats.map((file, index) => {
          return {
            name: file.path || `File ${index}`,
            size: file.length || 0,
            id: `${hash}:${index}`,
            url: `${this.#url}/stream/${encodeURIComponent(file.path || 'file.mp4')}?link=${hash}&index=${file.id}&play`,
            ready: true
          };
        }).filter(file => file.size > 0);
      }
      
      attempts++;
      await wait(2000);
    }
    
    throw new Error(ERROR.NOT_READY);
  }

  async #request(method, path, opts){
    opts = opts || {};
    const headers = opts.headers || {};
    
    if(this.#username && this.#password){
      const credentials = Buffer.from(`${this.#username}:${this.#password}`).toString('base64');
      headers['Authorization'] = `Basic ${credentials}`;
    }
    
    if(opts.body && typeof opts.body === 'string'){
      headers['Content-Type'] = 'application/json';
    }
    
    const url = `${this.#url}${path}`;
    
    const options = {
      method,
      body: opts.body
    };
    
    if(!opts.isFormData){
      options.headers = headers;
    } else {
      if(this.#username && this.#password){
        options.headers = {'Authorization': headers['Authorization']};
      }
    }
    
    const res = await fetch(url, options);
    
    if(!res.ok){
      if(res.status === 401){
        throw new Error(ERROR.EXPIRED_API_KEY);
      }
      throw new Error(`TorrServer error: ${res.status} ${res.statusText}`);
    }
    
    const contentType = res.headers.get('content-type');
    if(contentType && contentType.includes('application/json')){
      return await res.json();
    }
    
    return await res.text();
  }

}
