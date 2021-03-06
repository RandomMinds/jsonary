var changeListeners = [];
publicApi.registerChangeListener = function (listener) {
	changeListeners.push(listener);
};

var batchChanges = false;
var batchChangeDocuments = [];
publicApi.batch = function (batchFunc) {
	if (batchFunc != undefined) {
		publicApi.batch();
		batchFunc();
		publicApi.batchDone();
		return this;
	}
	batchChanges = true;
	return this;
};
publicApi.batchDone = function () {
	batchChanges = false;
	while (batchChangeDocuments.length > 0) {
		var document = batchChangeDocuments.shift();
		var patch = document.batchPatch;
		delete document.batchPatch;
		document.patch(patch);
	}
	return this;
};

function Document(url, isDefinitive, readOnly) {
	var thisDocument = this;
	this.readOnly = !!readOnly;
	this.isDefinitive = !!isDefinitive;
	this.url = url;
	this.http = {
		error: null
	};

	var rootPath = null;
	this.rootPath = function () {
		return rootPath;
	};
	var rawSecrets = {};
	this.raw = new Data(this, rawSecrets);
	this.uniqueId = this.raw.uniqueId;
	this.root = null;
	
	var documentChangeListeners = [];
	this.registerChangeListener = function (listener) {
		documentChangeListeners.push(listener);
	};
	function notifyChangeListeners(patch) {
		DelayedCallbacks.increment();
		var listeners = changeListeners.concat(documentChangeListeners);
		DelayedCallbacks.add(function () {
			for (var i = 0; i < listeners.length; i++) {
				listeners[i].call(thisDocument, patch, thisDocument);
			}
		});
		DelayedCallbacks.decrement();
	}

	var accessCallbacks = [];
	this.access = function () {
		while (accessCallbacks.length) {
			accessCallbacks.shift().call(this);
		}
	}
	this.whenAccessed = function (callback) {
		if (publicApi.config.accessImmediately) {
			callback.call(this);
		} else {
			accessCallbacks.push(callback);
		}
	}

	this.setRaw = function (value) {
		var needsFakePatch = this.raw.defined();
		rawSecrets.setValue(value);
		// It's an update to a read-only document
		if (needsFakePatch) {
			rawSecrets.setValue(value);
			var patch = new Patch();
			patch.replace(this.raw.pointerPath(), value);
			notifyChangeListeners(patch);
		}
	};
	var rootListeners = new ListenerSet(this);
	this.getRoot = function (callback) {
		if (this.root == null) {
			rootListeners.add(callback);
		} else {
			callback.call(this, this.root);
		}
	};
	this.setRoot = function (newRootPath) {
		rootPath = newRootPath;
		this.root = this.raw.subPath(newRootPath);
		rootListeners.notify(this.root);
	};
	this.patch = function (patch) {
		this.access();
		if (this.readOnly) {
			throw new Error("Cannot update read-only document");
		}
		if (batchChanges) {
			if (this.batchPatch == undefined) {
				this.batchPatch = new Patch();
				batchChangeDocuments.push(this);
			}
			this.batchPatch.operations = this.batchPatch.operations.concat(patch.operations);
			return;
		}
		DelayedCallbacks.increment();
		var rawPatch = patch.filter("?");
		var rootPatch = patch.filterRemainder("?");
		this.raw.patch(rawPatch);
		this.root.patch(rootPatch);
		notifyChangeListeners(patch);
		DelayedCallbacks.decrement();
	};
	this.affectedData = function (operation) {
		var subject = operation.subject();
		var subjectData = null;
		if (subject == "?" || subject.substring(0, 2) == "?/") {
			subjectData = this.raw.subPath(subject.substring(1));
		} else {
			subjectData = this.root.subPath(subject);
		}
		var result = [];
		while (subjectData != undefined) {
			result.push(subjectData);
			subjectData = subjectData.parent();
		}
		if (operation.action() == "move") {
			var target = operation.target();
			var targetData = null;
			if (target == "?" || target.substring(0, 2) == "?/") {
				targetData = this.raw.subPath(target.substring(1));
			} else {
				targetData = this.root.subPath(target);
			}
			result.push();
			while (targetData != undefined) {
				result.push(targetData);
				targetData = targetData.parent();
			}
		}
		return result;
	}
	
	var baseUrl = (this.url || '').split('#')[0];
	var fragmentMap = {};
	this.addSelfLink = function (link) {
		var href = link.rawLink.href;
		if (href.substring(0, baseUrl.length + 1) == baseUrl + '#') {
			var fragment = decodeURIComponent(href.substring(baseUrl.length + 1));
			fragmentMap[fragment] = link.dataObj;
		}
	};
	this.removeSelfLink = function (link) {
		var href = link.rawLink.href;
		if (href.substring(0, baseUrl.length + 1) == baseUrl + '#') {
			var fragment = decodeURIComponent(href.substring(baseUrl.length + 1));
			if (fragmentMap[fragment] == link.dataObj) {
				delete fragmentMap[fragment];
			}
		}
	};
	this.getFragment = function (fragment, callback) {
		if (fragmentMap[fragment] !== undefined) {
			callback.call(this, fragmentMap[fragment]);
			return;
		}
		this.getRoot(function (data) {
			if (fragment == "") {
				callback.call(this, data);
			} else {
				var fragmentData = data.subPath(fragment);
				callback.call(this, fragmentData);
			}
		});
	};
}

Document.prototype = {
	toString: function () {
		return "[Jsonary Document]";
	},
	resolveUrl: function (url) {
		return Uri.resolve(this.url, url);
	},
	get: function (path) {
		return this.root.get(path);
	},
	set: function (path, value) {
		this.root.set(path, value);
		return this;
	},
	move: function (source, target) {
		var patch = new Patch();
		patch.move(source, target);
		this.patch(patch);
		return this;
	},
	whenStable: function (callback) {
		callback.call(this, this);
		return this;
	}
}

var INDEX_REGEX = /^(0|[1-9]\d*)$/
function isIndex(value) {
	return INDEX_REGEX.test(value);
}

var META_SCHEMA_KEY = "meta-schema-key";

var uniqueIdCounter = 0;
function Data(document, secrets, parent, parentKey) {
	this.uniqueId = uniqueIdCounter++;
	this.document = document;
	this.readOnly = function (includeSchemas) {
		if (includeSchemas || includeSchemas === undefined) {
			return document.readOnly
				|| this.schemas().readOnly()
				|| (parent != undefined && parent.readOnly(true));
		} else {
			return document.readOnly;
		}
	};
	
	var value = undefined;
	var basicType = undefined;
	var length = 0;
	var keys = [];
	var propertyData = {};
	var propertyDataSecrets = {};
	this.property = function (key) {
		if (propertyData[key] == undefined) {
			propertyDataSecrets[key] = {};
			propertyData[key] = new Data(this.document, propertyDataSecrets[key], this, key);
			if (basicType == "object") {
				propertyDataSecrets[key].setValue(value[key]);
				if (value[key] !== undefined) {
					secrets.schemas.addSchemasForProperty(key, propertyData[key]);
				}
			}
		}
		return propertyData[key];
	};
	var indexData = {};
	var indexDataSecrets = {};
	this.item = function (index) {
		if (!isIndex(index)) {
			throw new Error("Index must be a positive integer (or integer-value string)");
		}
		if (indexData[index] == undefined) {
			indexDataSecrets[index] = {};
			indexData[index] = new Data(this.document, indexDataSecrets[index], this, index);
			if (basicType == "array") {
				indexDataSecrets[index].setValue(value[index]);
				if (value[index] !== undefined) {
					secrets.schemas.addSchemasForIndex(index, indexData[index]);
				}
			}
		}
		return indexData[index];
	}
	
	this.parent = function() {
		return parent;
	};
	this.parentKey = function () {
		return parentKey;
	};
	this.pointerPath = function () {
		if (this.document.root == this) {
			return "";
		} else if (parent != undefined) {
			return parent.pointerPath() + "/" + Utils.encodePointerComponent(parentKey);
		} else {
			return "?";
		}
	};
	
	this.basicType = function() {
		document.access();
		return basicType;
	};
	this.value = function() {
		document.access();
		if (basicType == "object") {
			var result = {};
			for (var i = 0; i < keys.length; i++) {
				var key = keys[i];
				if (propertyData[key] != undefined) {
					result[key] = propertyData[key].value();
				} else {
					result[key] = value[key];
				}
			}
			return result;
		} else if (basicType == "array") {
			var result = [];
			for (var i = 0; i < length; i++) {
				if (indexData[i] != undefined) {
					result[i] = indexData[i].value();
				} else {
					result[i] = value[i];
				}
			}
			return result;
		} else {
			return value;
		}
	};
	this.keys = function () {
		document.access();
		return keys.slice(0);
	};
	this.length = function () {
		document.access();
		return length;
	};
	
	this.patch = function (patch) {
		var thisData = this;
		var thisPath = this.pointerPath();
		var updateKeys = {};
		patch.each(function (i, operation) {
			if (operation.subjectEquals(thisPath)) {
				if (operation.action() == "replace" || operation.action() == "add") {
					operation.setSubjectValue(thisData.value());
					secrets.setValue(operation.value());
					if (basicType == "object") {
						
					}
				} else if (operation.action() == "remove") {
					if (!parent) {
						secrets.setValue(undefined);
					}
				} else if (operation.action() == "move") {
				} else {
					throw new Error("Unrecognised patch operation: " + operation.action());
				}
			} else if (operation.targetEquals(thisPath)) {
				if (operation.action() == "move") {
					secrets.setValue(operation.subjectValue());
				}
			} else {
				var child = operation.subjectChild(thisPath);
				if (typeof child == "string") {
					updateKeys[child] = true;
					if (basicType == "object") {
						if (operation.action() == "add") {
							var keyIndex = keys.indexOf(child);
							if (keyIndex != -1) {
								throw new Error("Cannot add existing key: " + child);
							}
							keys.push(child);
							value[child] = operation.value();
							if (propertyData[child] != undefined) {
								propertyDataSecrets[child].setValue(operation.value());
								secrets.schemas.addSchemasForProperty(child, propertyData[child]);
							}
						} else if (operation.action() == "remove" || operation.action() == "move") {
							var keyIndex = keys.indexOf(child);
							if (keyIndex == -1) {
								throw new Error("Cannot delete missing key: " + child);
							}
							operation.setSubjectValue(thisData.propertyValue(child));
							keys.splice(keyIndex, 1);
							if (propertyDataSecrets[child] != undefined) {
								propertyDataSecrets[child].setValue(undefined);
							}
							delete value[child];
						} else if (operation.action() == "replace") {
						} else {
							throw new Error("Unrecognised patch operation: " + operation.action());
						}
					} else if (basicType == "array") {
						if (!isIndex(child)) {
							throw new Error("Cannot patch non-numeric index: " + child);
						}
						var index = parseInt(child);
						if (operation.action() == "add") {
							if (index > length) {
								throw new Error("Cannot add past the end of the list");
							}
							for (var j = length - 1; j >= index; j--) {
								if (indexDataSecrets[j + 1] == undefined) {
									continue;
								}
								if (indexData[j] == undefined) {
									indexDataSecrets[j + 1].setValue(value[j]);
								} else {
									indexDataSecrets[j + 1].setValue(indexData[j].value());
								}
							}
							value.splice(index, 0, operation.value());
							length++;
							if (indexData[value.length - 1] != undefined) {
								secrets.schemas.addSchemasForIndex(value.length - 1, indexData[value.length - 1]);
							}
						} else if (operation.action() == "remove" || operation.action() == "move") {
							if (index >= length) {
								throw new Error("Cannot remove a non-existent index");
							}
							operation.setSubjectValue(thisData.itemValue(index));
							for (var j = index; j < length - 1; j++) {
								if (indexDataSecrets[j] == undefined) {
									continue;
								}
								if (indexData[j + 1] == undefined) {
									indexDataSecrets[j].setValue(value[j + 1]);
								} else {
									indexDataSecrets[j].setValue(indexData[j + 1].value());
								}
							}
							if (indexDataSecrets[length - 1] != undefined) {
								indexDataSecrets[length - 1].setValue(undefined);
							}
							length--;
							value.splice(index, 1);
						} else if (operation.action() == "replace") {
						} else {
							throw new Error("Unrecognised patch operation: " + operation.action());
						}
					}
				}
				var targetChild = operation.targetChild(thisPath);
				if (typeof targetChild == "string") {
					updateKeys[targetChild] = true;
					if (basicType == "object") {
						if (operation.action() == "move") {
							var keyIndex = keys.indexOf(targetChild);
							if (keyIndex != -1) {
								throw new Error("Cannot move to existing key: " + targetChild);
							}
							keys.push(targetChild);
							value[targetChild] = operation.subjectValue();
							if (propertyData[targetChild] != undefined) {
								secrets.schemas.addSchemasForProperty(targetChild, propertyData[targetChild]);
							}
						}
					} else if (basicType == "array") {
						if (!isIndex(targetChild)) {
							throw new Error("Cannot patch non-numeric index: " + targetChild);
						}
						var index = parseInt(targetChild);
						if (operation.action() == "move") {
							if (index > length) {
								throw new Error("Cannot add past the end of the list");
							}
							for (var j = length - 1; j >= index; j--) {
								if (indexDataSecrets[j + 1] == undefined) {
									continue;
								}
								if (indexData[j] == undefined) {
									indexDataSecrets[j + 1].setValue(value[j]);
								} else {
									indexDataSecrets[j + 1].setValue(indexData[j].value());
								}
							}
							value.splice(index, 0, operation.subjectValue());
							length++;
							if (indexData[value.length - 1] != undefined) {
								secrets.schemas.addSchemasForIndex(value.length - 1, indexData[value.length - 1]);
							}
						}
					}
				}
			}
		});
		if (basicType == "object") {
			for (var i = 0; i < keys.length; i++) {
				var key = keys[i];
				var subPatch = patch.filter("/" + Utils.encodePointerComponent(key));
				if (!subPatch.isEmpty()) {
					this.property(key).patch(subPatch);
				}
			}
		} else if (basicType == "array") {
			for (var i = 0; i < length; i++) {
				var subPatch = patch.filter("/" + Utils.encodePointerComponent(i));
				if (!subPatch.isEmpty()) {
					this.index(i).patch(subPatch);
				}
			}
		} else {
			// TODO: throw a wobbly
		}
		for (var key in updateKeys) {
			secrets.schemas.update(key);
		}
	};
	
	secrets.setValue = function (newValue) {
		var newBasicType = Utils.guessBasicType(newValue, basicType);
		var oldValue = value;
		value = newValue;
		if (newBasicType != basicType) {
			if (basicType == "object") {
				for (var key in propertyData) {
					propertyDataSecrets[key].setValue(undefined);
				}
			} else if (basicType == "array") {
				for (var index in indexData) {
					indexDataSecrets[index].setValue(undefined);
				}
			}
			basicType = newBasicType;
		}
		if (newBasicType == "object") {
			for (var key in propertyData) {
				if (newValue.hasOwnProperty(key)) {
					if (!propertyData[key].defined()) {
						secrets.schemas.addSchemasForProperty(key, propertyData[key]);
					}
					propertyDataSecrets[key].setValue(newValue[key]);
				} else {
					propertyDataSecrets[key].setValue(undefined);
				}
			}
			keys = Object.keys(newValue);
			length = 0;
		} else if (newBasicType == "array") {
			for (var index in indexData) {
				if (index < newValue.length) {
					if (!indexData[index].defined()) {
						secrets.schemas.addSchemasForIndex(index, indexData[index]);
					}
					indexDataSecrets[index].setValue(newValue[index]);
				} else {
					indexDataSecrets[index].setValue(undefined);
				}
			}
			keys = [];
			length = newValue.length;
		} else {
			keys = [];
			length = 0;
		}
		if (newValue === undefined) {
			if (oldValue !== undefined) {
				// we check oldValue, so we don't get a "schema changed" callback when we access an undefined property/index.
				secrets.schemas.clear();
			}
		} else {
			secrets.schemas.update(null);
		}
	};
	
	secrets.schemas = new SchemaSet(this);
	this.schemas = function (forceForUndefined) {
		if (forceForUndefined && basicType == undefined && parent) {
			if (parent.basicType() === 'array' && isIndex(parentKey)) {
				return parent.schemas(true).indexSchemas(parentKey);
			} else if (parent.basicType() === 'object') {
				return parent.schemas(true).propertySchemas(parentKey);
			}
		}
		document.access();
		return secrets.schemas.getSchemas();
	};
	this.whenSchemasStable = function(callback) {
		document.access();
		secrets.schemas.whenSchemasStable(callback);
		return this;
	};
	this.links = function (rel) {
		document.access();
		return secrets.schemas.getLinks(rel);
	};
	this.addLink = function (rawLink) {
		document.access();
		secrets.schemas.addLink(rawLink);
		return this;
	};
	this.addSchema = function (schema, schemaKey) {
		document.access();
		var thisData = this;
		if (schema instanceof SchemaList) {
			schema.each(function (index, schema) {
				thisData.addSchema(schema, schemaKey);
			});
		} else {
			secrets.schemas.addSchema(schema, schemaKey);
		}
		return this;
	};
	this.removeSchema = function ( schemaKey) {
		document.access();
		secrets.schemas.removeSchema(schemaKey);
		return this;
	};
	// TODO: remove this
	this.addSchemaMatchMonitor = function (monitorKey, schema, monitor, executeImmediately, impatientCallbacks) {
		document.access();
		return secrets.schemas.addSchemaMatchMonitor(monitorKey, schema, monitor, executeImmediately, impatientCallbacks);
	};
	this.validate = function () {
		document.access();
		return secrets.schemas.validate();
	};
}
Data.prototype = {
	toString: function () {
		return "[Jsonary Data]";
	},
	referenceUrl: function () {
		if (this.document.isDefinitive) {
			var pointerPath = this.pointerPath();
			if (pointerPath == "" || pointerPath.charAt(0) == "/") {
				return this.document.url + "#" + encodeURI(this.pointerPath());
			}
		}
	},
	subPath: function (path) {
		var parts = path.split("/");
		if (parts[0] != "") {
			throw new Error("Path must begin with / (or be empty): " + path);
		}
		var result = this;
		for (var i = 1; i < parts.length; i++) {
			parts[i] = Utils.decodePointerComponent(parts[i]);
			if (result.basicType() == "array") {
				result = result.index(parts[i]);
			} else {
				result = result.property(parts[i]);
			}
		}
		return result;
	},
	defined: function () {
		return this.basicType() != undefined;
	},
	setValue: function (newValue) {
		if (typeof newValue == "undefined") {
			return this.remove();
		}
		if (this.basicType() != "object" && this.basicType() != "array" && this.value() === newValue) {
			return this;
		}
		var patch = new Patch();
		if (this.defined()) {
			patch.replace(this.pointerPath(), newValue);
		} else {
			patch.add(this.pointerPath(), newValue);
		}
		this.document.patch(patch, this);
		return this;
	},
	remove: function () {
		var patch = new Patch();
		patch.remove(this.pointerPath());
		this.document.patch(patch, this);
		return this;
	},
	itemValue: function (index) {
		return this.index(index).value();
	},
	removeItem: function (index) {
		this.index(index).remove();
		return this;
	},
	insertItem: function (index, value) {
		if (this.basicType() != "array") {
			throw Error("cannot insert into a non-array");
		}
		var patch = new Patch();
		patch.add(this.item(index).pointerPath(), value);
		this.document.patch(patch, this);
		return this;
	},
	push: function (value) {
		if (this.basicType() == "array") {
			this.index(this.length()).setValue(value);
		} else {
			throw new Error("Can only push() on an array");
		}
		return this;
	},
	propertyValue: function (key) {
		return this.property(key).value();
	},
	removeProperty: function (key) {
		this.property(key).remove();
		return this;
	},
	moveTo: function (target) {
		if (typeof target == "object") {
			if (target.document != this.document) {
				var value = this.value();
				this.remove();
				target.setValue(value);
				return target;
			}
			target = target.pointerPath();
		}
		var patch = new Patch();
		var pointerPath = this.pointerPath();
		if (target == pointerPath) {
			return;
		}
		patch.move(pointerPath, target);
		this.document.patch(patch, this);
		return this.document.root.subPath(target);
	},
	getLink: function (rel) {
		var links = this.links(rel);
		return links[0];
	},
	equals: function (otherData) {
		var i;
		var basicType = this.basicType();
		if (basicType != otherData.basicType()) {
			return false;
		}
		if (basicType == "array") {
			if (this.length() !== otherData.length()) {
				return false;
			}
			for (i = 0; i < this.length(); i++) {
				if (!this.index(i).equals(otherData.index(i))) {
					return false;
				}
			}
			return true;
		} else if (basicType == "object") {
			var i;
			var keys = this.keys();
			var otherKeys = otherData.keys();
			if (keys.length != otherKeys.length) {
				return false;
			}
			keys.sort();
			otherKeys.sort();
			for (i = 0; i < keys.length; i++) {
				if (keys[i] !== otherKeys[i]) {
					return false;
				}
			}
			for (i = 0; i < keys.length; i++) {
				var key = keys[i];
				if (!this.property(key).equals(otherData.property(key))) {
					return false;
				}
			}
			return true;
		} else {
			return this.value() === otherData.value();
		}
	},
	readOnlyCopy: function () {
		if (this.readOnly(false)) {
			return this;
		}
		var url = this.resolveUrl('#:copy');
		var copy = publicApi.create(this.value(), url, true);
		copy.addSchema(this.schemas().fixed());
		return copy;
	},
	editableCopy: function () {
		var url = this.resolveUrl('#:copy');
		var copy = publicApi.create(this.value(), url, false);
		copy.addSchema(this.schemas().fixed());
		return copy;
	},
	asSchema: function () {
		var readOnlyCopy = this.readOnlyCopy();
		var schema = new Schema(readOnlyCopy);
		if (this.readOnly(false)) {
			cacheResult(this, {asSchema: schema});
		}
		if (!readOnlyCopy.property("$ref").defined()) {
			readOnlyCopy.addSchema("http://json-schema.org/hyper-schema", META_SCHEMA_KEY);
		}
		return schema;
	},
	asLink: function (targetData) {
		var readOnlyCopy = this.readOnlyCopy();
		var linkDefinition = new PotentialLink(readOnlyCopy);
		var result;
		if (targetData == undefined) {
			result = linkDefinition.linkForData(this);
		} else {
			result = linkDefinition.linkForData(targetData);
		}
		if (this.readOnly(false)) {
			cacheResult(this, {asLink: result});
		}
		return result;
	},
	items: function (callback) {
		for (var i = 0; i < this.length(); i++) {
			var subData = this.index(i);
			callback.call(subData, i, subData);
		}
		return this;
	},
	properties: function (keys, callback, additionalCallback) {
		var dataKeys;
		if (typeof keys == 'function') {
			callback = keys;
			keys = this.keys();
		}
		if (callback) {
			for (var i = 0; i < keys.length; i++) {
				var subData = this.property(keys[i]);
				callback.call(subData, keys[i], subData);
			}
		}
		if (additionalCallback) {
			if (typeof additionalCallback != 'function') {
				additionalCallback = callback;
			}
			var dataKeys = this.keys();
			for (var i = 0; i < dataKeys.length; i++) {
				if (keys.indexOf(dataKeys[i]) == -1) {
					var subData = this.property(dataKeys[i]);
					additionalCallback.call(subData, dataKeys[i], subData);
				}
			}
		}
		return this;
	},
	resolveUrl: function (url) {
		var data = this;
		while (data) {
			var selfLink = data.getLink("self");
			if (selfLink) {
				return Uri.resolve(selfLink.href, url);
			}
			data = data.parent();
		}
		return this.document.resolveUrl(url);
	},
	get: function (path) {
		if (!path) {
			return this.value();
		}
		return this.subPath(path).value();
	},
	set: function (path, value) {
		if (arguments.length == 1) {
			return this.setValue(path);
		}
		this.subPath(path).setValue(value);
		return this;
	},
	json: function (indent) {
		return JSON.stringify(this.value(), null, indent);
	},
	whenStable: function (callback) {
		var thisData = this;
		this.document.whenStable(function () {
			thisData.whenSchemasStable(callback.bind(thisData, thisData));
		});
		return this;
	},
	valid: function () {
		return this.validate().valid;
	}
};
Data.prototype.indices = Data.prototype.items;
Data.prototype.indexValue = Data.prototype.itemValue;
Data.prototype.removeIndex = Data.prototype.removeItem;
Data.prototype.index = function (index) {
	return this.item(index);
};

publicApi.extendData = function (obj) {
	for (var key in obj) {
		if (Data.prototype[key] == undefined) {
			Data.prototype[key] = obj[key];
		}
	}
};


publicApi.create = function (rawData, baseUrl, readOnly) {
	var rawData = (typeof rawData == "object") ? JSON.parse(JSON.stringify(rawData)) : rawData; // Hacky recursive copy
	var definitive = baseUrl != undefined && readOnly;
	if (baseUrl != undefined && baseUrl.indexOf("#") != -1) {
		var remainder = baseUrl.substring(baseUrl.indexOf("#") + 1);
		if (remainder != "") {
			definitive = false;
		}
		baseUrl = baseUrl.substring(0, baseUrl.indexOf("#"));
	}
	var document = new Document(baseUrl, definitive, readOnly);
	document.setRaw(rawData);
	document.setRoot("");
	return document.root;
};
publicApi.isData = function (obj) {
	return obj instanceof Data;
};

Data.prototype.deflate = function () {
	var result = this.document.deflate();
	return {
		document: this.document.deflate(),
		path: this.pointerPath()
	}
};
Document.prototype.deflate = function (canUseUrl) {
	if (this.isDefinitive) {
		return this.url;
	}
	var rawData = this.raw;
	var schemas = [];
	rawData.schemas().fixed().each(function (index, schema) {
		if (schema.referenceUrl() != undefined) {
			schemas.push(schema.referenceUrl());
		} else {
			schemas.push(schema.data.deflate());
		}
	});
	var result = {
		baseUrl: this.url,
		readOnly: this.readOnly,
		value: rawData.value(),
		schemas: schemas,
		root: this.rootPath()
	}
	return result;
};
publicApi.inflate = function (deflated, callback) {
	if (deflated.path !== undefined && deflated.document !== undefined) {
		return publicApi.inflate(deflated.document).root.subPath(deflated.path);
	}
	if (typeof deflated == "string") {
		var request = requestJson(deflated).request;
		if (callback) {
			request.document.getRoot(function (root) {
				root.whenSchemasStable(function () {
					callback(null, request.document);
				});
			});
		}
		return request.document;
	}
	var data = publicApi.create(deflated.value, deflated.baseUrl, deflated.readOnly);
	for (var i = 0; i < deflated.schemas.length; i++) {
		var schema = deflated.schemas[i];
		if (typeof schema == "object") {
			var schema = publicApi.inflate(schema).asSchema();
		}
		data.addSchema(schema);
	}
	data.document.setRoot(deflated.root);
	var result = data.document;
	if (callback) {
		callback(null, result);
	}
	return result;
};
