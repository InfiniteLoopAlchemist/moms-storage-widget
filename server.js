const express = require('express');
const axios = require('axios');
const cron = require('node-cron');
const encodeUrl = require('encodeurl');

const app = express();
const port = 3000;

const DSM_URL = `http://${ process.env.SYNOLOGY_IP }:5000`;
const USERNAME = process.env.SYNOLOGY_USER;
const PASSWORD = process.env.SYNOLOGY_PASS;
const SHARED_FOLDER_PATH = '/Moms-Storage';
const MAX_SIZE_TB = 6;
const MAX_SIZE_BYTES = MAX_SIZE_TB * 1024 ** 4;

let folderSizeData = {};

const getApiInfo = async( session ) => {
    console.log('Starting to retrieve API info');
    const response = await session.get('/webapi/query.cgi', {
        params: {
            api: 'SYNO.API.Info',
            version: '1',
            method: 'query',
            query: 'SYNO.API.Auth,SYNO.FileStation.DirSize'
        }
    });
    console.log('API info retrieved');
    return response.data;
};

const loginDsm = async( session, authPath ) => {
    console.log('Starting DSM login');
    const response = await session.get(`/webapi/${ authPath }`, {
        params: {
            api: 'SYNO.API.Auth',
            version: '3',
            method: 'login',
            account: USERNAME,
            passwd: PASSWORD,
            session: 'FileStation',
            format: 'sid'
        }
    });
    console.log('DSM login completed');
    if ( ! response.data || ! response.data.data || ! response.data.data.sid ) {
        console.error('Failed to retrieve session ID');
        throw new Error('Session ID is undefined');
    }
    return response.data;
};

const startFolderSizeCalculation = async( session, sid, dirsizePath ) => {
    console.log('Starting folder size calculation');
    const response = await session.get(`/webapi/${ dirsizePath }`, {
        params: {
            api: 'SYNO.FileStation.DirSize',
            version: '2',
            method: 'start',
            path: encodeUrl([ SHARED_FOLDER_PATH ]),
            _sid: sid
        }
    });
    console.log('Folder size calculation started');
    return response.data;
};

const getFolderSizeStatus = async( session, sid, dirsizePath, taskid ) => {
    console.log('Retrieving folder size status');
    const response = await session.get(`/webapi/${ dirsizePath }`, {
        params: {
            api: 'SYNO.FileStation.DirSize',
            version: '2',
            method: 'status',
            taskid: taskid,
            _sid: sid
        }
    });
    console.log('Folder size status retrieved');
    return response.data;
};

const stopFolderSizeCalculation = async( session, sid, dirsizePath, taskid ) => {
    console.log('Stopping folder size calculation');
    const response = await session.get(`/webapi/${ dirsizePath }`, {
        params: {
            api: 'SYNO.FileStation.DirSize',
            version: '2',
            method: 'stop',
            taskid: taskid,
            _sid: sid
        }
    });
    console.log('Folder size calculation stopped');
    return response.data;
};

const logoutDsm = async( session, authPath, sid ) => {
    console.log('Starting DSM logout');
    const response = await session.get(`/webapi/${ authPath }`, {
        params: {
            api: 'SYNO.API.Auth',
            version: '1',
            method: 'logout',
            session: 'FileStation',
            _sid: sid
        }
    });
    console.log('DSM logout completed');
    return response.data;
};

const calculateFolderSize = async() => {
    console.log('Folder size calculation initiated');
    const session = axios.create({
        baseURL: DSM_URL,
        timeout: 10000
    });
    
    try {
        const apiInfo = await getApiInfo(session);
        console.log('API Info retrieved');
        if ( ! apiInfo.success ) {
            console.error('Failed to retrieve API info');
            return;
        }
        
        const authPath = apiInfo.data['SYNO.API.Auth'].path;
        const dirsizePath = apiInfo.data['SYNO.FileStation.DirSize'].path;
        
        const loginInfo = await loginDsm(session, authPath);
        console.log('Login Info retrieved:');
        if ( ! loginInfo.success ) {
            console.error('Failed to log in');
            return;
        }
        
        const sid = loginInfo.data.sid;
        console.log(`New session ID for this run: ${ sid }`);
        
        const startInfo = await startFolderSizeCalculation(session, sid, dirsizePath);
        console.log('Start Info retrieved:');
        if ( ! startInfo.success ) {
            console.error('Failed to start folder size calculation');
            return;
        }
        
        const taskid = startInfo.data.taskid;
        let sizeInfo = {};
        
        while ( true ) {
            console.log(`Loop iteration with taskid: ${ taskid }`);
            try {
                sizeInfo = await getFolderSizeStatus(session, sid, dirsizePath, taskid);
                if ( sizeInfo.success && sizeInfo.data.finished ) {
                    console.log('Folder size calculation finished');
                    if ( ! sizeInfo.success ) {
                        console.error('Failed to retrieve final folder size');
                        return;
                    }
                    
                    const totalSizeBytes = sizeInfo.data.total_size;
                    const usedPercentage = (totalSizeBytes / MAX_SIZE_BYTES) * 100;
                    
                    folderSizeData = {
                        current_size_bytes: totalSizeBytes,
                        max_size_bytes: MAX_SIZE_BYTES,
                        used_percentage: usedPercentage
                    };
                    console.log('Folder size data:', folderSizeData);
                    
                    // Stop the folder size calculation task
                    await stopFolderSizeCalculation(session, sid, dirsizePath, taskid);
                    
                    await logoutDsm(session, authPath, sid);
                    
                    console.log('Folder size calculation completed');
                    break;
                } else if ( sizeInfo.success ) {
                    console.log('Folder size calculation in progress...');
                } else {
                    
                    console.log(`Failed to retrieve folder size status: ${ JSON.stringify(sizeInfo.error) }Retrying...`);
                    // Stop the folder size calculation task
                    await stopFolderSizeCalculation(session, sid, dirsizePath, taskid);
                    
                    await logoutDsm(session, authPath, sid);
                    return calculateFolderSize();
                }
            } catch ( error ) {
                
                
                console.log(`Error checking folder size status: ${ error.message }  `);
                return;
            }
            await new Promise(resolve => setTimeout(resolve, 30000)); // Sleep for 30 seconds
        }
        
        
    } catch ( error ) {
        console.error('Exception occurred:', error.message);
    }
};

// Schedule the folder size calculation every hour between 5 AM and 10 PM using node-cron
cron.schedule('*/30 8-22 * * *', async() => {
    console.log('Scheduled task started: calculateFolderSize');
    await calculateFolderSize();
});

app.get('/api/folder-size', ( req, res ) => {
    res.json(folderSizeData);
});

app.listen(port, () => {
    console.log(`Server running at http://0.0.0.0:${ port }/`);
    // Initial run of the folder size calculation
    calculateFolderSize();
});
