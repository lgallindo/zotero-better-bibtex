declare const Zotero: any
declare const window: any

import debug = require('./debug.ts')
import flash = require('./flash.ts')
import Events = require('./events.ts')
import ETA = require('node-eta')
import ZoteroDB = require('./db/zotero.ts')

import getItemsAsync = require('./get-items-async.ts')

import Prefs = require('./prefs.ts')
import Citekey = require('./keymanager/get-set.ts')
import DB = require('./db/main.ts')
import Formatter = require('./keymanager/formatter.ts')

class KeyManager {
  private static postfixRE = {
    numeric: /^(-[0-9]+)?$/,
    alphabetic: /^([a-z])?$/,
  }

  private scanning: any[]
  private query: {
    field: { extra?: number }
    type: {
      note?: number,
      attachment?: number
    }
  }

  public keys: any

  public async pin(ids) {
    ids = this.expandSelection(ids)
    debug('KeyManager.pin', ids)

    for (const item of await getItemsAsync(ids)) {
      if (item.isNote() || item.isAttachment()) continue

      const parsed = Citekey.get(item.getField('extra'))
      if (parsed.pinned) continue

      try {
        const citekey = this.get(item.id).citekey || this.update(item)
        item.setField('extra', Citekey.set(parsed.extra, citekey))
        await item.saveTx() // this should cause an update and key registration
      } catch (err) {
        debug('KeyManager.pin', err)
      }
    }
  }

  public async unpin(ids) {
    ids = this.expandSelection(ids)
    debug('KeyManager.unpin', ids)

    for (const item of await getItemsAsync(ids)) {
      if (item.isNote() || item.isAttachment()) continue

      const parsed = Citekey.get(item.getField('extra'))
      if (!parsed.pinned) continue

      debug('KeyManager.unpin', item.id)
      item.setField('extra', parsed.extra) // citekey is stripped here but will be regenerated by the notifier
      item.saveTx()
    }

  }

  public async refresh(ids, warn = false) {
    ids = this.expandSelection(ids)
    debug('KeyManager.refresh', ids)

    const warnAt = warn ? Prefs.get('warnBulkModify') : 0
    if (warnAt > 0 && ids.length > warnAt) {
      const affected = this.keys.find({ itemID: { $in: ids }, pinned: false }).length
      if (affected > warnAt) {
        const params = { treshold: warnAt, response: null }
        window.openDialog('chrome://zotero-better-bibtex/content/bulk-keys-confirm.xul', '', 'chrome,dialog,centerscreen,modal', params)
        switch (params.response) {
          case 'ok':
            break
          case 'whatever':
            Prefs.set('warnBulkModify', 0)
            break
          default:
            return
        }
      }
    }

    for (const item of await getItemsAsync(ids)) {
      if (item.isNote() || item.isAttachment()) continue

      const parsed = Citekey.get(item.getField('extra'))
      debug('KeyManager.refresh?', item.id, parsed)
      if (parsed.pinned) continue

      this.update(item)
    }

  }

  private expandSelection(ids) {
    if (Array.isArray(ids)) return ids

    if (ids === 'selected') {
      try {
        return Zotero.getActiveZoteroPane().getSelectedItems(true)
      } catch (err) { // zoteroPane.getSelectedItems() doesn't test whether there's a selection and errors out if not
        debug('Could not get selected items:', err)
        return []
      }
    }

    return [ids]
  }

  public async init() {
    debug('KeyManager.init...')

    this.keys = DB.getCollection('citekey')
    debug('KeyManager.init:', { keys: this.keys })

    this.query = {
      field: {},
      type: {},
    }

    for (const field of await ZoteroDB.queryAsync("select fieldID, fieldName from fields where fieldName in ('extra')")) {
      this.query.field[field.fieldName] = field.fieldID
    }
    for (const type of await ZoteroDB.queryAsync("select itemTypeID, typeName from itemTypes where typeName in ('note', 'attachment')")) { // 1, 14
      this.query.type[type.typeName] = type.itemTypeID
    }

    Formatter.update()

    await this.rescan()

    debug('KeyManager.init: done')

    Events.on('preference-changed', pref => {
      debug('KeyManager.pref changed', pref)
      if (['autoAbbrevStyle', 'citekeyFormat', 'citekeyFold', 'skipWords'].includes(pref)) {
        Formatter.update()
      }
    })

    this.keys.on(['insert', 'update'], citekey => {
      const extraData = {}
      // prevents update loop -- see Zotero.Notifier.registerObserver in main
      extraData[citekey.itemID] = { bbtCitekeyUpdate: true }

      // update display panes
      Zotero.Notifier.trigger('modify', 'item', [citekey.itemID], extraData)
    })

  }

  public async rescan(clean?: boolean) {
    if (Array.isArray(this.scanning)) {
      let left
      if (this.scanning.length) {
        left = `, ${this.scanning.length} items left`
      } else {
        left = ''
      }
      flash('Scanning still in progress', `Scan is still running${left}`)
      return
    }

    this.scanning = []

    if (clean) {
      this.keys.removeDataOnly()
    }
//    else
//      @keys.findAndRemove({ citekey: '' }) # how did empty keys get into the DB?!
    debug('KeyManager.rescan:', {clean, keys: this.keys})

    const marker = '\uFFFD'

    const ids = []
    const items = await ZoteroDB.queryAsync(`
      SELECT item.itemID, item.libraryID, extra.value as extra, item.itemTypeID
      FROM items item
      LEFT JOIN itemData field ON field.itemID = item.itemID AND field.fieldID = ${this.query.field.extra}
      LEFT JOIN itemDataValues extra ON extra.valueID = field.valueID
      WHERE item.itemID NOT IN (select itemID from deletedItems)
      AND item.itemTypeID NOT IN (${this.query.type.attachment}, ${this.query.type.note})
    `)
    for (const item of items) {
      ids.push(item.itemID)
      // if no citekey is found, it will be '', which will allow it to be found right after this loop
      const citekey = Citekey.get(item.extra)
      debug('KeyManager.rescan:', {itemID: item.itemID, citekey})

      const saved = clean ? null : this.keys.findOne({ itemID: item.itemID })
      if (saved) {
        if (citekey.pinned && ((citekey.citekey !== saved.citekey) || !saved.pinned)) {
          debug('KeyManager.rescan: resetting pinned citekey', citekey.citekey, 'for', item.itemID)
          Object.assign(saved, { citekey: citekey.citekey, pinned: true })
          this.keys.update(saved)
        } else {
          debug('KeyManager.rescan: keeping', saved)
        }
      } else {
        debug('KeyManager.rescan: clearing citekey for', item.itemID)
        this.keys.insert({ citekey: citekey.citekey || marker, pinned: citekey.pinned, itemID: item.itemID, libraryID: item.libraryID })
      }
    }

    debug('KeyManager.rescan: found', this.keys.data.length)
    this.keys.findAndRemove({ itemID: { $nin: ids } })
    debug('KeyManager.rescan: purged', this.keys.data.length)

    // find all references without citekey
    this.scanning = this.keys.find({ citekey: marker })

    if (this.scanning.length !== 0) {
      debug(`Found ${this.scanning.length} references without a citation key`)
      const progressWin = new Zotero.ProgressWindow({ closeOnClick: false })
      progressWin.changeHeadline('Better BibTeX: Assigning citation keys')
      progressWin.addDescription(`Found ${this.scanning.length} references without a citation key`)
      const icon = `chrome://zotero/skin/treesource-unfiled${Zotero.hiDPI ? '@2x' : ''}.png`
      const progress = new progressWin.ItemProgress(icon, 'Assigning citation keys')
      progressWin.show()

      const eta = new ETA(this.scanning.length, { autoStart: true })
      for (let done = 0; done < this.scanning.length; done++) {
        const key = this.scanning[done]

        try {
          this.update(await getItemsAsync(key.itemID), key)
        } catch (err) {
          debug('KeyManager.rescan: update', done, 'failed:', err)
        }

        eta.iterate()

        // tslint:disable-next-line:no-magic-numbers
        if ((done % 10) === 1) {
          // tslint:disable-next-line:no-magic-numbers
          progress.setProgress((eta.done * 100) / eta.count)
          progress.setText(eta.format(`${eta.done} / ${eta.count}, {{etah}} remaining`))
        }
      }

      // tslint:disable-next-line:no-magic-numbers
      progress.setProgress(100)
      progress.setText('Ready')
      // tslint:disable-next-line:no-magic-numbers
      progressWin.startCloseTimer(500)
    }

    this.scanning = null

    debug('KeyManager.rescan: done updating citation keys')
  }

  private postfixAlpha(n) {
    const ordA = 'a'.charCodeAt(0)
    const ordZ = 'z'.charCodeAt(0)
    const len = ordZ - ordA + 1

    let postfix = ''
    while (n >= 0) {
      postfix = String.fromCharCode(n % len + ordA) + postfix
      n = Math.floor(n / len) - 1
    }
    return postfix
  }

  private propose(item) {
    debug('KeyManager.propose: getting existing key from extra field,if any')
    let citekey = Citekey.get(item.getField('extra'))
    debug('KeyManager.propose: found key', citekey)

    if (citekey.pinned) return { citekey: citekey.citekey, pinned: true }

    debug('KeyManager.propose: formatting...', citekey)
    const proposed = Formatter.format(item)
    debug('KeyManager.propose: proposed=', proposed)

    if (citekey = this.keys.findOne({ itemID: item.id })) {
      // item already has proposed citekey ?
      debug(`KeyManager.propose: testing whether ${item.id} can keep ${citekey.citekey}`)
      if (citekey.citekey.startsWith(proposed.citekey)) {                                                         // key begins with proposed sitekey
        const re = proposed.postfix === '0' ? KeyManager.postfixRE.numeric : KeyManager.postfixRE.alphabetic
        if (citekey.citekey.slice(proposed.citekey.length).match(re)) {                                           // rest matches proposed postfix
          let other
          if (!(other = this.keys.findOne({ libraryID: item.libraryID, citekey: citekey.citekey, itemID: { $ne: item.id } }))) { // noone else is using it
            return { citekey: citekey.citekey, pinned: false }
          }
        }
      }
    }
//          else
//            debug('KeyManager.propose: no, because', other, 'is using it')
//        else
//          debug('KeyManager.propose: no, because', citekey.citekey.slice(proposed.citekey.length), 'does not match', '' + re)
//      else
//        debug('KeyManager.propose: no, because', citekey.citekey, 'does not start with', citekey.citekey)

    debug(`KeyManager.propose: testing whether ${item.id} can use proposed ${proposed.citekey}`)
    // unpostfixed citekey is available
    if (!this.keys.findOne({ libraryID: item.libraryID, citekey: proposed.citekey, itemID: { $ne: item.id } })) {
      debug(`KeyManager.propose: ${item.id} can use proposed ${proposed.citekey}`)
      return { citekey: proposed.citekey, pinned: false}
    }

    debug(`KeyManager.propose: generating free citekey from ${item.id} from`, proposed.citekey)
    for (let postfix = 0; true; postfix += 1) {
      const postfixed = proposed.citekey + (proposed.postfix === '0' ? `-${postfix + 1}` : this.postfixAlpha(postfix))
      if (!this.keys.findOne({ libraryID: item.libraryID, citekey: postfixed })) {
        debug(`KeyManager.propose: found <${postfixed}> for ${item.id}`)
        return { citekey: postfixed, pinned: false }
      }
    }
  }

  public update(item, current?) {
    if (item.isNote() || item.isAttachment()) return

    current = current || this.keys.findOne({ itemID: item.id })
    const proposed = this.propose(item)

    if (current && (current.pinned === proposed.pinned) && (current.citekey === proposed.citekey)) return current.citekey

    if (current) {
      current.pinned = proposed.pinned
      current.citekey = proposed.citekey
      this.keys.update(current)
    } else {
      this.keys.insert({ itemID: item.id, libraryID: item.libraryID, pinned: proposed.pinned, citekey: proposed.citekey })
    }

    return proposed.citekey
  }

  public remove(ids) {
     if (!Array.isArray(ids)) ids = [ids]
     debug('KeyManager.remove:', ids)
     this.keys.findAndRemove({ itemID : { $in : ids } })
   }

  public get(itemID) {
    // I cannot prevent being called before the init is done because Zotero unlocks the UI *way* before I'm getting the
    // go-ahead to *start* my init.
    if (!this.keys) return { citekey: '', pinned: false, retry: true }

    const key = this.keys.findOne({ itemID })
    if (key) return key

    debug('KeyManager.get called for non-existent', itemID)
    return { citekey: '', pinned: false }
  }
}

export = new KeyManager()