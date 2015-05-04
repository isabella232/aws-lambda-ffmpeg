var child_process = require('child_process');
var fs = require('fs');
var util = require('util');
var zlib = require('zlib');
var AWS = require('aws-sdk');
var async = require('async');
var uuid = require('uuid');
var config = require('./config');
var scaleFilter = "scale='min(" + config.videoMaxWidth.toString() + "\\,iw):-2'";

var s3 = new AWS.S3();

function downloadStream(bucket, file, context) {
	var req = s3.getObject({
		Bucket: bucket,
		Key: file
	});

	req.on('error', function(res) {
		return context.fail('S3 download error: ' + JSON.stringify(res));
	});

	return req.createReadStream();
}

function uploadFile(cb, filename, bucket, key, contentType) {
	var readStream = fs.createReadStream(filename);

	var params = {
		Bucket: bucket,
		Key: key,
		ContentType: contentType
	};

	if (config.gzip) {
		params.Body = readStream.pipe(
			zlib.createGzip({
				level: zlib.Z_BEST_COMPRESSION
			})
		);
		params.ContentEncoding = 'gzip';
	} else {
		params.Body = readStream;
	}

	s3.upload(params)
		.on('httpUploadProgress', function(evt) {
			console.log(filename, 'Progress:', evt.loaded, '/', evt.total);
		})
		.send(cb);
}

function getffmpeg(dstBucket, keyPrefix, description, context) {
	console.log('starting ffmpeg');

	var ffmpeg = child_process.execFile(
		process.env.ffmpeg || '/tmp/ffmpeg',
		[
			'-y',
			'-loglevel', 'warning',
			'-i', '-',
			'-vf', scaleFilter,
			'-movflags', '+faststart',
			'-metadata', 'description=' + description,
			'out.mp4',
			'-vf', 'thumbnail',
			'-vf', scaleFilter,
			'-vframes', '1',
			'out.png'
		],
		{
			cwd: '/tmp',
			stdio: [null, null, null, 'pipe']
		}
	);

	ffmpeg.on('exit', function (code, signal) {
		console.log('ffmpeg done');

		if (code) {
			console.log(code.toString());
			return context.fail('ffmpeg Error code:' + code.toString() + 'signal:' + signal);
		}

		async.parallel(
			[
				function (callback) {
					console.log('uploading mp4');
					uploadFile(callback, '/tmp/out.mp4', dstBucket, keyPrefix + '.mp4', 'video/mp4')
				},
				function (callback) {
					console.log('uploading png');
					uploadFile(callback, '/tmp/out.png', dstBucket, keyPrefix + '.png', 'image/png')
				}
			],
			function (err, results) {
				if (err)
					context.fail('Uploads failed' + err + ' ' + JSON.stringify(results));

				console.log('Uploads finished', results);
				context.succeed();
			}
		);
	});

	return ffmpeg;
}

function uuid2shorturl(id) {
	return new Buffer(uuid.parse(id))
		.toString('base64')
		.substring(0, 22)
		.replace(/\+/g, '-')
		.replace(/\//g, '_');
}

//Main handler
exports.handler = function(event, context) {
	console.log('starting function');
	// http://stackoverflow.com/questions/27708573/aws-lambda-making-video-thumbnails
	child_process.exec('cp /var/task/ffmpeg /tmp/.; chmod 755 /tmp/ffmpeg;', function(error, stdout, stderr) {
		if (error) {
			console.log(stdout);
			console.log(stderr);
			return context.fail('Error', error);
		}

		console.log(event);
		context.succeed(event);
		return;
	});
};
